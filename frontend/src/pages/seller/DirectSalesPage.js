import { useState, useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import { productService, sellerService, comboService } from '../../services/api';
import LoadingSpinner from '../../components/LoadingSpinner';

const DirectSalesPage = () => {
	const [products, setProducts] = useState([]);
	const [quantities, setQuantities] = useState({});
	const [loading, setLoading] = useState(true);
	const [processing, setProcessing] = useState(false);
	const [currentOrder, setCurrentOrder] = useState(null);
	const [paymentQR, setPaymentQR] = useState('');
	const [pricingInfo, setPricingInfo] = useState(null);
	const [loadingPricing, setLoadingPricing] = useState(false);

	// Refs for input focus management
	const inputRefs = useRef({});

	// Fetch products
	useEffect(() => {
		const fetchProducts = async () => {
			try {
				const response = await productService.getDirectSalesProducts();
				if (response.success) {
					setProducts(response.data.products);
					// Initialize quantities
					const initialQuantities = {};
					response.data.products.forEach(product => {
						initialQuantities[product._id] = 0;
					});
					setQuantities(initialQuantities);
				}
			} catch (error) {
				toast.error('Lỗi khi tải danh sách sản phẩm');
			} finally {
				setLoading(false);
			}
		};

		fetchProducts();
	}, []);

	// Auto-focus first input when products are loaded
	useEffect(() => {
		if (products.length > 0 && !loading) {
			const firstProductId = products[0]._id;
			const timer = setTimeout(() => {
				if (inputRefs.current[firstProductId]) {
					inputRefs.current[firstProductId].focus();
				}
			}, 100);
			return () => clearTimeout(timer);
		}
	}, [products, loading]);

	const updateQuantity = (productId, delta) => {
		setQuantities(prev => {
			const newQuantities = {
				...prev,
				[productId]: Math.max(0, (prev[productId] || 0) + delta)
			};

			// Trigger pricing calculation
			calculatePricing(newQuantities);

			return newQuantities;
		});
	};

	// Calculate optimal pricing for current selection
	const calculatePricing = async (currentQuantities = quantities) => {
		const items = Object.entries(currentQuantities)
			.filter(([_, qty]) => qty > 0)
			.map(([productId, quantity]) => ({
				productId,
				quantity
			}));

		if (items.length === 0) {
			setPricingInfo(null);
			return;
		}

		setLoadingPricing(true);
		try {
			const result = await comboService.calculatePricing(items);

			if (result.success) {
				setPricingInfo(result.data);
			} else {
				console.error('Pricing calculation failed:', result.message);
				setPricingInfo(null);
			}
		} catch (error) {
			console.error('Pricing calculation error:', error.message || error);
			setPricingInfo(null);
		} finally {
			setLoadingPricing(false);
		}
	};

	// Handle Tab navigation between quantity inputs
	const focusNextInput = (currentProductId) => {
		const currentIndex = products.findIndex(p => p._id === currentProductId);
		const nextIndex = (currentIndex + 1) % products.length; // Loop back to first if at end
		const nextProductId = products[nextIndex]._id;

		if (inputRefs.current[nextProductId]) {
			inputRefs.current[nextProductId].focus();
		}
	};

	const focusPrevInput = (currentProductId) => {
		const currentIndex = products.findIndex(p => p._id === currentProductId);
		const prevIndex = currentIndex === 0 ? products.length - 1 : currentIndex - 1; // Loop to last if at first
		const prevProductId = products[prevIndex]._id;

		if (inputRefs.current[prevProductId]) {
			inputRefs.current[prevProductId].focus();
		}
	};

	const handleKeyPress = (e, productId) => {
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			updateQuantity(productId, 1);
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			updateQuantity(productId, -1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			handleCreateOrder();
		} else if (e.key === 'Tab') {
			e.preventDefault();
			if (e.shiftKey) {
				focusPrevInput(productId);
			} else {
				focusNextInput(productId);
			}
		}
	};

	const handleCreateOrder = async () => {
		// Check if any products are selected
		const selectedItems = Object.entries(quantities)
			.filter(([_, qty]) => qty > 0)
			.map(([productId, quantity]) => {
				const product = products.find(p => p._id === productId);
				return {
					productId,
					productName: product.name,
					price: product.price,
					quantity
				};
			});

		if (selectedItems.length === 0) {
			toast.warning('Vui lòng chọn ít nhất một sản phẩm');
			return;
		}

		setProcessing(true);
		try {
			// Get optimal pricing for this selection
			const pricingData = pricingInfo || null;

			// Create order through seller service
			const orderData = {
				items: selectedItems,
				isDirectSale: true,
				// Include optimal pricing information if available
				optimalPricing: pricingData,
				useOptimalPricing: pricingData && pricingData.summary && pricingData.summary.totalSavings > 0
			};

			const response = await sellerService.createDirectOrder(orderData);

			if (response.success) {
				const order = response.data;
				setCurrentOrder(order);
				setPaymentQR(order.qrUrl || '');

				// Show combo info if applied (silently without warning).
				// F12: the seller direct-sale route always writes the
				// multi-combo shape ({savings, originalTotal, finalTotal,
				// combos[], breakdown} — see routes/seller.js), which has no
				// top-level comboName; combo names live in comboInfo.combos[].
				if (order.comboInfo && order.comboInfo.savings > 0) {
					const comboNames = (order.comboInfo.combos || []).map((c) => c.comboName).join(', ');
					toast.success(`Đã tạo đơn hàng thành công! Áp dụng combo "${comboNames}" tiết kiệm ${formatCurrency(order.comboInfo.savings)}`);
				} else {
					toast.success('Đã tạo đơn hàng thành công!');
				}
			}
		} catch (error) {
			toast.error('Lỗi khi tạo đơn hàng: ' + error.message);
		} finally {
			setProcessing(false);
		}
	};

	const handlePaymentAction = async (action) => {
		if (!currentOrder) return;

		setProcessing(true);
		try {
			let transactionCode = '';
			let status = 'delivered';

			if (action === 'transfer') {
				transactionCode = 'TransferAtCounter';
			} else if (action === 'cash') {
				transactionCode = 'CashAtCounter';
			} else if (action === 'cancel') {
				status = 'cancelled';
			}

			const updateData = {
				status,
				transactionCode,
				cancelReason: action === 'cancel' ? 'Hủy tại quầy' : undefined
			};

			const response = await sellerService.updateOrderStatus(currentOrder._id, updateData);

			if (response.success) {
				toast.success(`Đã ${action === 'cancel' ? 'hủy' : 'hoàn thành'} đơn hàng!`);
				handleReset();
			}
		} catch (error) {
			console.error('Update order error:', error);
			toast.error('Lỗi khi cập nhật đơn hàng: ' + (error.response?.data?.message || error.message));
		} finally {
			setProcessing(false);
		}
	};

	const handleReset = () => {
		setCurrentOrder(null);
		setPaymentQR('');
		// Reset quantities
		const resetQuantities = {};
		products.forEach(product => {
			resetQuantities[product._id] = 0;
		});
		setQuantities(resetQuantities);
	};

	const getTotalAmount = () => {
		// Use optimal pricing if available
		if (pricingInfo && pricingInfo.summary) {
			return pricingInfo.summary.finalTotal;
		}

		// Fallback to basic calculation
		return Object.entries(quantities).reduce((total, [productId, quantity]) => {
			const product = products.find(p => p._id === productId);
			return total + (product ? product.price * quantity : 0);
		}, 0);
	};

	const formatCurrency = (amount) => {
		return new Intl.NumberFormat('vi-VN', {
			style: 'currency',
			currency: 'VND'
		}).format(amount);
	};

	if (loading) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<LoadingSpinner size="large" text="Đang tải sản phẩm..." />
			</div>
		);
	}

	return (
		<div className="container mx-auto px-4 py-8">
			<div className="max-w-6xl mx-auto">
				{/* Header */}
				<div className="text-center mb-8">
					<h1 className="text-3xl font-bold text-gray-900 mb-2">
						<i className="fas fa-cash-register mr-3 text-blue-700"></i>
						Bán hàng trực tiếp
					</h1>
					<p className="text-gray-600 mb-2">
						Nhập số lượng sản phẩm và tạo đơn hàng cho khách hàng tại quầy
					</p>
					<div className="text-sm text-gray-500 bg-blue-50 p-3 rounded-lg inline-block">
						<i className="fas fa-keyboard mr-2"></i>
						<span className="font-semibold">Phím tắt:</span>
						<span className="mx-2">↑↓ để tăng/giảm</span>
						<span className="mx-2">Tab để chuyển sản phẩm</span>
						<span className="mx-2">Enter để tạo đơn</span>
					</div>
				</div>

				{!currentOrder ? (
					/* Product Selection */
					<div className="space-y-6">
						{/* Products Grid */}
						<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
							{products.map(product => (
								<div key={product._id} className="card p-6">
									<h3 className="text-lg font-semibold text-gray-900 mb-2">
										{product.name}
									</h3>
									<p className="text-gray-600 text-sm mb-3">
										{product.description}
									</p>
									<p className="text-blue-700 font-bold mb-4">
										{formatCurrency(product.price)}
									</p>

									{/* Quantity Input */}
									<div className="flex items-center space-x-3">
										<button
											onClick={() => updateQuantity(product._id, -1)}
											className="w-8 h-8 bg-gray-200 hover:bg-gray-300 rounded flex items-center justify-center"
											disabled={quantities[product._id] === 0}
										>
											<i className="fas fa-minus text-sm"></i>
										</button>

										<input
											ref={(el) => inputRefs.current[product._id] = el}
											type="number"
											value={quantities[product._id] || 0}
											onChange={(e) => {
												const newQuantities = {
													...quantities,
													[product._id]: Math.max(0, parseInt(e.target.value) || 0)
												};
												setQuantities(newQuantities);
												calculatePricing(newQuantities);
											}}
											onKeyDown={(e) => handleKeyPress(e, product._id)}
											className="w-16 px-2 py-1 text-center border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
											min="0"
											tabIndex={products.findIndex(p => p._id === product._id) + 1}
											title="Sử dụng ↑↓ để thay đổi số lượng, Tab để chuyển sản phẩm, Enter để tạo đơn"
										/>

										<button
											onClick={() => updateQuantity(product._id, 1)}
											className="w-8 h-8 bg-gray-200 hover:bg-gray-300 rounded flex items-center justify-center"
										>
											<i className="fas fa-plus text-sm"></i>
										</button>
									</div>

									{quantities[product._id] > 0 && (
										<p className="text-sm text-gray-600 mt-2">
											Tổng: {formatCurrency(product.price * quantities[product._id])}
										</p>
									)}
								</div>
							))}
						</div>

						{/* Summary and Action */}
						<div className="card p-6">
							<div className="flex justify-between items-center mb-4">
								<h3 className="text-xl font-semibold text-gray-900">
									Tổng đơn hàng
								</h3>
								<span className="text-2xl font-bold text-blue-700">
									{loadingPricing ? '...' : formatCurrency(getTotalAmount())}
								</span>
							</div>

							{/* Pricing Breakdown */}
							{pricingInfo && pricingInfo.summary.totalSavings > 0 && (
								<div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
									<div className="flex items-center justify-between mb-2">
										<span className="text-green-800 font-medium">
											<i className="fas fa-gift mr-2"></i>
											Combo tối ưu được áp dụng
										</span>
										<span className="text-green-700 font-bold">
											-{formatCurrency(pricingInfo.summary.totalSavings)}
										</span>
									</div>

									{pricingInfo.combos.length > 0 && (
										<div className="text-sm text-green-700 space-y-1">
											{pricingInfo.combos.map((combo, index) => (
												<div key={index} className="flex justify-between">
													<span>{combo.name} x{combo.applications}</span>
													<span>{formatCurrency(combo.totalPrice)}</span>
												</div>
											))}
										</div>
									)}

									<div className="text-xs text-green-600 mt-2">
										Giá gốc: {formatCurrency(pricingInfo.summary.originalTotal)} →
										Giá sau combo: {formatCurrency(pricingInfo.summary.finalTotal)}
									</div>
								</div>
							)}

							<div className="flex justify-center">
								<button
									onClick={handleCreateOrder}
									disabled={getTotalAmount() === 0 || processing}
									className="btn-primary px-8 py-3 text-lg disabled:opacity-50 disabled:cursor-not-allowed"
								>
									{processing ? (
										<>
											<LoadingSpinner size="small" />
											<span className="ml-2">Đang tạo...</span>
										</>
									) : (
										<>
											<i className="fas fa-qrcode mr-2"></i>
											Tạo mã QR thanh toán
										</>
									)}
								</button>
							</div>
						</div>
					</div>
				) : (
					/* Order Created - Payment QR */
					<div className="space-y-6">
						{/* Order Info */}
						<div className="card p-6">
							<div className="text-center mb-6">
								<h2 className="text-2xl font-bold text-gray-900 mb-2">
									Đơn hàng #{currentOrder.orderCode}
								</h2>
								<p className="text-gray-600">
									Tổng tiền: <span className="font-bold text-blue-700">{formatCurrency(currentOrder.totalAmount)}</span>
								</p>

								{/* Combo Info — F12: comboInfo.comboName does not exist on the
								    multi-combo shape this route writes; combo names live in
								    comboInfo.combos[]. See the comment on the toast above. */}
								{currentOrder.comboInfo && currentOrder.comboInfo.savings > 0 && (
									<div className="mt-3 inline-block bg-green-50 border border-green-200 rounded-lg px-4 py-2">
										<div className="flex items-center space-x-2 text-sm">
											<i className="fas fa-gift text-green-600"></i>
											<span className="text-green-800 font-medium">
												Đã áp dụng combo "{(currentOrder.comboInfo.combos || []).map((c) => c.comboName).join(', ')}"
											</span>
											<span className="text-green-700">
												- Tiết kiệm {formatCurrency(currentOrder.comboInfo.savings)}
											</span>
										</div>
									</div>
								)}
							</div>

							{/* QR Code */}
							<div className="text-center mb-6">
								<div className="bg-white rounded-lg p-4 shadow-inner mb-4 inline-block">
									<img
										src={paymentQR}
										alt="Payment QR Code"
										className="w-64 h-64 mx-auto"
									/>
								</div>
								<p className="text-sm text-gray-600">
									Quét mã QR để thanh toán hoặc chọn phương thức thanh toán bên dưới
								</p>
							</div>

							{/* Payment Actions */}
							<div className="flex justify-center space-x-4">
								<button
									onClick={() => handlePaymentAction('cancel')}
									disabled={processing}
									className="btn-danger px-6 py-3"
								>
									<i className="fas fa-times mr-2"></i>
									Hủy đơn
								</button>

								<button
									onClick={() => handlePaymentAction('transfer')}
									disabled={processing}
									className="btn-warning px-6 py-3"
								>
									<i className="fas fa-credit-card mr-2"></i>
									Đã chuyển khoản
								</button>

								<button
									onClick={() => handlePaymentAction('cash')}
									disabled={processing}
									className="btn-success px-6 py-3"
								>
									<i className="fas fa-money-bill-wave mr-2"></i>
									Đã nhận tiền mặt
								</button>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
};

export default DirectSalesPage;
