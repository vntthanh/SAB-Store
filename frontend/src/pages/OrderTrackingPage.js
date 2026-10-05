import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { orderService, formatCurrency, formatDate, getStatusText, getStatusColor } from '../services/api';
import LoadingSpinner from '../components/LoadingSpinner';
import MarkdownContent from '../components/MarkdownContent';
import usePublicSettings from '../hooks/usePublicSettings';
import useFieldErrors from '../hooks/use-field-errors';
import FormField from '../components/form/FormField';

// Order codes are 5 characters (generateOrderCode on the server); anything shorter cannot exist.
const TRACKING_RULES = {
	orderCode: (value) => {
		const v = value.trim();
		if (!v) return 'Vui lòng nhập mã đơn hàng';
		return v.length < 5 ? 'Mã đơn hàng không hợp lệ' : null;
	}
};

const OrderTrackingPage = () => {
	const settings = usePublicSettings();
	const [searchParams, setSearchParams] = useSearchParams();
	const [orderCode, setOrderCode] = useState('');
	const [order, setOrder] = useState(null);
	const [loading, setLoading] = useState(false);
	// Server-side lookup failure (e.g. order not found), shown under the same input.
	const [lookupError, setLookupError] = useState('');
	const { errors, validateField, onFieldChange, validateAll, focusFirstError, reset: resetFieldErrors } = useFieldErrors(TRACKING_RULES);
	const formRef = useRef(null);
	const [paymentQR, setPaymentQR] = useState(null);

	// Handle URL query parameters on component mount
	useEffect(() => {
		const codeFromUrl = searchParams.get('code');
		if (codeFromUrl && codeFromUrl.trim()) {
			const cleanCode = codeFromUrl.trim().toUpperCase();
			setOrderCode(cleanCode);

			// Auto-trigger search if valid code
			if (cleanCode.length >= 5) {
				performSearch(cleanCode);
			}
		}
	}, [searchParams]);

	// Extracted search logic for reuse
	const performSearch = async (codeToSearch) => {
		setLoading(true);
		setLookupError('');
		setOrder(null);

		try {
			const response = await orderService.getOrderByCode(codeToSearch.trim().toUpperCase());

			if (response.success) {
				setOrder(response.data);
				setPaymentQR(response.data.qrUrl);
			}
		} catch (err) {
			setLookupError(err.message);
			toast.error(err.message);
		} finally {
			setLoading(false);
		}
	};

	const handleSearch = async (e) => {
		e.preventDefault();

		if (!validateAll({ orderCode })) {
			focusFirstError(formRef);
			return;
		}

		// Update URL with current search code
		const cleanCode = orderCode.trim().toUpperCase();
		if (cleanCode) {
			setSearchParams({ code: cleanCode });
		}

		await performSearch(orderCode);
	};

	const handleReset = () => {
		setOrderCode('');
		setOrder(null);
		setLookupError('');
		setPaymentQR(null);
		resetFieldErrors();

		// Clear URL query parameters
		setSearchParams({});
	};

	const getStatusSteps = (currentStatus) => {
		let steps = [
			{ key: 'confirmed', label: 'Đã xác nhận đơn hàng', icon: 'fas fa-check-circle' },
			{ key: 'paid', label: 'Đã thanh toán', icon: 'fas fa-credit-card' },
			{ key: 'delivered', label: 'Đã giao hàng', icon: 'fas fa-truck' }
		];

		const statusOrder = ['confirmed', 'paid', 'delivered'];
		const currentIndex = statusOrder.indexOf(currentStatus);
		const isCancelled = currentStatus === 'cancelled';

		steps.forEach((step, index) => {
			if (index > currentIndex) {
				step.label = step.label.replace('Đã', 'Chờ xác nhận');
			}
		});

		return steps.map((step, index) => ({
			...step,
			completed: !isCancelled && index <= currentIndex,
			active: !isCancelled && index === currentIndex,
			cancelled: isCancelled
		}));
	};

	return (
		<div className="container mx-auto px-4 py-8">
			<div className="max-w-2xl mx-auto">
				{/* Header */}
				<div className="text-center mb-8">
					<h1 className="text-3xl font-bold text-gray-900 mb-2">
						<i className="fas fa-search mr-3 text-blue-700"></i>
						Tra cứu đơn hàng
					</h1>
					<p className="text-gray-600">
						Nhập mã đơn hàng để xem trạng thái và chi tiết đơn hàng
					</p>
				</div>

				{/* Search Form */}
				<div className="card mb-8">
					<form ref={formRef} onSubmit={handleSearch} noValidate className="p-6">
						<div className="flex items-start space-x-3">
							<div className="flex-1">
								<FormField
									id="orderCode"
									label="Mã đơn hàng" required
									error={errors.orderCode || lookupError}
								>
									<input
										type="text"
										name="orderCode"
										value={orderCode}
										onChange={(e) => {
											const value = e.target.value.toUpperCase();
											setOrderCode(value);
											setLookupError('');
											onFieldChange('orderCode', value);
										}}
										onBlur={(e) => validateField('orderCode', e.target.value)}
										placeholder="Nhập mã đơn hàng"
										className="form-input"
										style={{ textTransform: 'uppercase' }}
									/>
								</FormField>
							</div>
							{/* mt-7 = label height + gap, so the button lines up with the input */}
							<button
								type="submit"
								disabled={loading}
								className="btn-primary px-6 mt-7"
							>
								{loading ? (
									<LoadingSpinner size="small" />
								) : (
									<>
										<i className="fas fa-search mr-2"></i>
										Tìm kiếm
									</>
								)}
							</button>
						</div>
					</form>
				</div>

				{/* Order Details */}
				{order && (
					<div className="space-y-6">
						{/* Order Status */}
						<div className="card">
							<div className="bg-primary-50 px-6 py-4 border-b border-primary-100">
								<div className="flex items-center justify-between">
									<h2 className="text-xl font-semibold text-gray-900">
										Đơn hàng #{order.orderCode}
									</h2>
									<span className={`badge ${getStatusColor(order.status)}`}>
										{getStatusText(order.status)}
									</span>
								</div>
							</div>

							<div className="p-6">
								{/* Order Info */}
								<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
									<div>
										<p className="text-sm text-gray-600">Ngày đặt hàng:</p>
										<p className="font-semibold text-gray-900">
											{formatDate(order.createdAt)}
										</p>
									</div>
									<div>
										<p className="text-sm text-gray-600">Cập nhật lần cuối:</p>
										<p className="font-semibold text-gray-900">
											{formatDate(order.statusUpdatedAt)}
										</p>
									</div>
								</div>

								{/* Status Timeline */}
								{order.status !== 'cancelled' ? (
									<div className="mb-6">
										<h3 className="font-semibold text-gray-900 mb-4">Tiến trình đơn hàng:</h3>
										<div className="relative flex items-center justify-between">
											{getStatusSteps(order.status).map((step, index) => (
												<div key={step.key} className="flex flex-col items-center flex-1 relative">
													<div className={`w-10 h-10 rounded-full flex items-center justify-center mb-2 relative z-10 ${step.completed
														? 'bg-success-100 text-success-600'
														: step.active
															? 'bg-blue-100 text-blue-700'
															: 'bg-gray-100 text-gray-400'
														}`}>
														<i className={step.icon}></i>
													</div>
													<span className={`text-xs text-center ${step.completed || step.active
														? 'text-gray-900 font-medium'
														: 'text-gray-400'
														}`}>
														{step.label}
													</span>

													{/* Connector line */}
													{index < getStatusSteps(order.status).length - 1 && (
														<div className={`absolute top-5 left-1/2 h-0.5 ${step.completed ? 'bg-success-300' : 'bg-gray-200'
															}`} style={{
																width: 'calc(100% - 20px)',
																marginLeft: '10px'
															}}></div>
													)}
												</div>
											))}
										</div>
									</div>
								) : (
									<div className="mb-6 p-4 bg-danger-50 border border-danger-200 rounded-lg">
										<div className="flex items-center space-x-2">
											<i className="fas fa-times-circle text-danger-600"></i>
											<h3 className="font-semibold text-danger-900">Đơn hàng đã bị hủy</h3>
										</div>
										<p className="text-danger-700 text-sm mt-1">
											Đơn hàng này đã được hủy vào {formatDate(order.statusUpdatedAt)}
										</p>
									</div>
								)}
							</div>
						</div>

						{/* Order Items */}
						<div className="card">
							<div className="bg-gray-50 px-6 py-4 border-b border-gray-100">
								<h3 className="text-lg font-semibold text-gray-900">
									Chi tiết đơn hàng
								</h3>
							</div>

							<div className="p-6">
								<div className="space-y-4">
									{order.items.map((item, index) => (
										<div key={index} className="flex justify-between items-center py-3 border-b border-gray-100 last:border-b-0">
											<div className="flex-1">
												<h4 className="font-medium text-gray-900">{item.productName}</h4>
												<p className="text-gray-600 text-sm">
													{formatCurrency(item.price)} x {item.quantity}
												</p>
											</div>
											<div className="text-right">
												<p className="font-semibold text-gray-900">
													{formatCurrency(item.price * item.quantity)}
												</p>
											</div>
										</div>
									))}
								</div>

								{/* Total */}
								<div className="border-t pt-4 mt-4">
									<div className="flex justify-between items-center text-lg font-bold">
										<span className="text-gray-900">Tổng cộng:</span>
										<span className="text-blue-700">
											{formatCurrency(order.totalAmount)}
										</span>
									</div>
								</div>
							</div>
						</div>

						{/* Payment QR Code - Show only if not paid and not cancelled */}
						{paymentQR && order.status !== 'paid' && order.status !== 'delivered' && order.status !== 'cancelled' && (
							<>
								<div className="bg-gradient-to-br from-red-50 to-orange-50 border-2 border-red-200 rounded-lg p-6 mb-8">
									<div className="text-center">
										{/* Urgent Payment Header */}
										<div className="mb-4">
											<h3 className="text-xl font-bold text-red-700 mb-2">
												<i className="fas fa-exclamation-triangle mr-2"></i>
												Chờ xác nhận từ người bán
											</h3>
											{settings?.paymentNotice && (
												<MarkdownContent className="text-red-600 text-sm">
													{settings.paymentNotice}
												</MarkdownContent>
											)}
										</div>

										{/* QR Code */}
										<div className="bg-white rounded-lg p-4 shadow-inner mb-4 inline-block">
											<img
												src={paymentQR}
												alt="Payment QR Code"
												className="w-64 h-64 mx-auto"
												onError={(e) => {
													e.target.style.display = 'none';
													e.target.nextSibling.style.display = 'block';
												}}
											/>
											<div
												className="w-64 h-64 bg-gray-200 flex items-center justify-center text-gray-500"
												style={{ display: 'none' }}
											>
												<i className="fas fa-image text-4xl"></i>
												<p>Không thể tải QR</p>
											</div>
										</div>

										{/* Payment Instructions */}
										<div className="text-left space-y-3">
											<h4 className="font-semibold text-gray-900 text-center">
												<i className="fas fa-mobile-alt mr-2"></i>
												Hướng dẫn thanh toán
											</h4>

											<div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
												<ol className="space-y-2 text-gray-700">
													<li className="flex items-start">
														<span className="bg-primary-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs mr-2 mt-0.5">1</span>
														Mở ứng dụng ngân hàng hoặc ví điện tử
													</li>
													<li className="flex items-start">
														<span className="bg-primary-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs mr-2 mt-0.5">2</span>
														Quét mã QR bên trái
													</li>
													<li className="flex items-start">
														<span className="bg-primary-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs mr-2 mt-0.5">3</span>
														Kiểm tra thông tin và xác nhận thanh toán
													</li>
												</ol>

												<div className="bg-gray-50 rounded-lg p-3">
													<h5 className="font-semibold text-gray-900 mb-2">Thông tin chuyển khoản:</h5>
													<div className="space-y-1 text-xs text-gray-600">
														<p><strong>Số tiền:</strong> {formatCurrency(order.totalAmount)}</p>
														<p><strong>Nội dung:</strong> {order.paymentDescription}</p>
														<p className="text-red-600 font-medium">
															⚠️ Không thay đổi nội dung chuyển khoản
														</p>
													</div>
												</div>
											</div>
										</div>
									</div>
								</div>
							</>
						)}

						{/* Actions */}
						<div className="flex justify-center space-x-4">
							<button
								onClick={handleReset}
								className="btn-secondary"
							>
								<i className="fas fa-search mr-2"></i>
								Tra cứu đơn khác
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
};

export default OrderTrackingPage;
