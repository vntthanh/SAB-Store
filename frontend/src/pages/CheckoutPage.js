import React, { useState, useEffect, useRef } from 'react';
import { STUDENT_ID_PATTERN, STUDENT_ID_HINT } from '../utils/student-id';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useCart } from '../context/CartContext';
import { orderService, PRICE_CHANGED } from '../services/api';
import LoadingSpinner from '../components/LoadingSpinner';
import MarkdownContent from '../components/MarkdownContent';
import usePublicSettings from '../hooks/usePublicSettings';
import useFieldErrors from '../hooks/use-field-errors';
import FormField from '../components/form/FormField';

// Client rules mirror validateOrder in backend/middleware/validation.js (the server stays authoritative).
const CHECKOUT_RULES = {
	studentId: (value) => {
		const v = value.trim();
		if (!v) return 'Mã số sinh viên là bắt buộc';
		return STUDENT_ID_PATTERN.test(v) ? null : STUDENT_ID_HINT;
	},
	fullName: (value) => {
		const v = value.trim();
		if (!v) return 'Họ tên là bắt buộc';
		if (v.length < 2 || v.length > 100) return 'Họ tên phải từ 2-100 ký tự';
		return /^[a-zA-ZÀ-ỹ\s]+$/.test(v) ? null : 'Họ tên chỉ được chứa chữ cái và khoảng trắng';
	},
	email: (value) => {
		const v = value.trim();
		if (!v) return 'Email là bắt buộc';
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Email không hợp lệ';
		return v.length > 100 ? 'Email không được vượt quá 100 ký tự' : null;
	},
	phoneNumber: (value) => {
		const v = value.trim();
		if (!v) return 'Số điện thoại là bắt buộc';
		return /^0[0-9]{9}$/.test(v) ? null : 'Số điện thoại phải có 10 số và bắt đầu bằng 0';
	},
	additionalNote: (value) => (value.length > 500 ? 'Ghi chú không được vượt quá 500 ký tự' : null)
};

const CheckoutPage = () => {
	const settings = usePublicSettings();
	const navigate = useNavigate();
	const { cart, getCartTotal, formatCurrency, clearCart, getPricingBreakdown, comboDetection, pricingError, checkForCombos } = useCart();

	const [formData, setFormData] = useState({
		studentId: '',
		fullName: '',
		email: '',
		phoneNumber: '',
		additionalNote: ''
	});

	const { errors, validateField, onFieldChange, validateAll, setServerErrors, focusFirstError } = useFieldErrors(CHECKOUT_RULES);
	const formRef = useRef(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [orderCompleted, setOrderCompleted] = useState(false);

	// Redirect if cart is empty (but not if order was just completed)
	useEffect(() => {
		if (cart.items.length === 0 && !orderCompleted && !isSubmitting) {
			toast.warning('Giỏ hàng trống. Vui lòng thêm sản phẩm trước khi thanh toán.');
			navigate('/');
		}
	}, [cart.items.length, navigate, orderCompleted, isSubmitting]);

	const handleInputChange = (e) => {
		const { name, value } = e.target;
		setFormData(prev => ({ ...prev, [name]: value }));
		onFieldChange(name, value, { ...formData, [name]: value });
	};

	const handleBlur = (e) => {
		validateField(e.target.name, e.target.value, formData);
	};

	const handleSubmit = async (e) => {
		e.preventDefault();

		if (!validateAll(formData)) {
			focusFirstError(formRef);
			return;
		}

		if (cart.items.length === 0) {
			toast.error('Giỏ hàng trống');
			return;
		}

		if (pricingError) {
			toast.error('Không tính được giá, vui lòng thử lại');
			return;
		}

		setIsSubmitting(true);

		try {
			// The total shown on this page; the server refuses the order (409)
			// if it no longer computes the same amount.
			const expectedTotal = getCartTotal();

			const orderData = {
				studentId: formData.studentId.trim(),
				fullName: formData.fullName.trim(),
				email: formData.email.trim().toLowerCase(),
				phoneNumber: formData.phoneNumber.trim(),
				additionalNote: formData.additionalNote.trim(),
				items: cart.items.map(item => ({
					productId: item.productId,
					quantity: item.quantity
				})),
				expectedTotal
			};

			const response = await orderService.createOrder(orderData);

			if (response.success) {
				// Set order completed flag to prevent useEffect redirect
				setOrderCompleted(true);

				// Clear cart
				clearCart();

				// Show success message
				toast.success('Đơn hàng đã được tạo thành công!');

				// Small delay to ensure toast is shown before navigation
				setTimeout(() => {
					// Redirect to success page with order info
					navigate('/order-success', {
						state: {
							orderCode: response.data.orderCode,
							totalAmount: response.data.totalAmount,
							qrUrl: response.data.qrUrl,
							paymentDescription: response.data.paymentDescription,
							customerInfo: {
								studentId: formData.studentId.trim(),
								fullName: formData.fullName.trim(),
								email: formData.email.trim()
							}
						}
					});
				}, 100);
			}
		} catch (error) {
			if (error.code === PRICE_CHANGED) {
				toast.warning('Giá vừa thay đổi, vui lòng xem lại giỏ hàng');
				checkForCombos();
				return;
			}
			if (error.status === 400 && error.fieldErrors?.length) {
				const leftovers = setServerErrors(error);
				if (leftovers.length < error.fieldErrors.length) focusFirstError(formRef);
				if (leftovers.length > 0) toast.error(leftovers.map(l => l.message).join('. '));
				return;
			}
			console.error('Order creation error:', error);
			toast.error(error.message || 'Có lỗi xảy ra khi tạo đơn hàng');
		} finally {
			setIsSubmitting(false);
		}
	};

	const total = getCartTotal();
	const pricingBreakdown = getPricingBreakdown();

	if (cart.items.length === 0 && !orderCompleted) {
		return null; // Will redirect in useEffect
	}

	return (
		<div className="container mx-auto px-4 py-8">
			<div className="max-w-4xl mx-auto">
				{/* Header */}
				<div className="text-center mb-8">
					<h1 className="text-3xl font-bold text-gray-900 mb-2">
						<i className="fas fa-credit-card mr-3 text-blue-700"></i>
						Xác nhận đơn hàng
					</h1>
					<p className="text-gray-600">
						Vui lòng điền đầy đủ thông tin để hoàn tất đơn hàng
					</p>
				</div>

				<div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
					{/* Order Form */}
					<div className="xl:col-span-2">
						<div className="card">
							<div className="bg-blue-50 px-6 py-4 border-b border-blue-100">
								<h2 className="text-xl font-semibold text-gray-900">
									Thông tin đặt hàng
								</h2>
							</div>

							<form id="checkout-form" ref={formRef} onSubmit={handleSubmit} noValidate className="p-6 space-y-6">
									<FormField
										id="studentId"
										label="Mã số sinh viên" required
										error={errors.studentId}
									>
										<input
											type="text"
											name="studentId"
											value={formData.studentId}
											onChange={handleInputChange}
											onBlur={handleBlur}
											placeholder="Nhập mã số sinh viên"
											className="form-input"
											maxLength="20"
										/>
									</FormField>

									<FormField
										id="fullName"
										label="Họ tên" required
										error={errors.fullName}
									>
										<input
											type="text"
											name="fullName"
											value={formData.fullName}
											onChange={handleInputChange}
											onBlur={handleBlur}
											placeholder="Nhập họ tên đầy đủ"
											className="form-input"
											maxLength="100"
										/>
									</FormField>

									<FormField
										id="email"
										label="Email" required
										error={errors.email}
										hint="Email sẽ được sử dụng để gửi xác nhận đơn hàng"
									>
										<input
											type="email"
											name="email"
											value={formData.email}
											onChange={handleInputChange}
											onBlur={handleBlur}
											placeholder="Nhập địa chỉ email"
											className="form-input"
											maxLength="100"
										/>
									</FormField>

									<FormField
										id="phoneNumber"
										label="Số điện thoại" required
										error={errors.phoneNumber}
										hint="Ưu tiên số điện thoại có sử dụng Zalo."
									>
										<input
											type="text"
											name="phoneNumber"
											value={formData.phoneNumber}
											onChange={handleInputChange}
											onBlur={handleBlur}
											placeholder="Nhập số điện thoại"
											className="form-input"
											maxLength="10"
										/>
									</FormField>

									<FormField
										id="additionalNote"
										label="Ghi chú"
										error={errors.additionalNote}
										hint={`${formData.additionalNote.length}/500`}
									>
										<textarea
											name="additionalNote"
											value={formData.additionalNote}
											onChange={handleInputChange}
											onBlur={handleBlur}
											placeholder="Nếu còn điều gì cần lưu ý với SAB, bạn hãy điền vào đây nhé!"
											rows="3"
											className="form-input"
											maxLength="500"
										/>
									</FormField>
							</form>
						</div>
					</div>

					{/* Order Summary */}
					<div className="xl:col-span-1">
						<div className="card sticky top-24 xl:w-[380px] w-full">
							<div className="bg-blue-50 px-6 py-4 border-b border-blue-100">
								<h3 className="text-lg font-semibold text-gray-900">
									Tóm tắt đơn hàng
								</h3>
							</div>

							<div className="p-6">
								{/* Order Items */}
								<div className="space-y-3 mb-6">
									{cart.items.map(item => (
										<div key={item.productId} className="flex justify-between items-start">
											<div className="flex-1 mr-2">
												<h4 className="font-medium text-gray-900 text-sm line-clamp-2">
													{item.productName}
												</h4>
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

								{/* Combo Savings Display */}
								{pricingBreakdown.savings > 0 && (
									<div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
										<div className="flex items-center justify-between mb-2">
											<span className="text-green-800 font-medium text-sm">
												<i className="fas fa-gift mr-2"></i>
												Combo tối ưu được áp dụng
											</span>
											<span className="text-green-700 font-bold">
												-{formatCurrency(pricingBreakdown.savings)}
											</span>
										</div>

										{pricingBreakdown.combos && pricingBreakdown.combos.length > 0 && (
											<div className="text-sm text-green-700 space-y-1">
												{pricingBreakdown.combos.map((combo, index) => (
													<div key={index} className="flex justify-between">
														<span>{combo.comboName} x{combo.applications}</span>
														<span>-{formatCurrency(combo.savings)}</span>
													</div>
												))}
											</div>
										)}

										<div className="text-xs text-green-600 mt-2">
											Giá gốc: {formatCurrency(pricingBreakdown.originalTotal)} →
											Giá sau combo: {formatCurrency(pricingBreakdown.totalAmount)}
										</div>
									</div>
								)}

								{/* Total */}
								<div className="border-t pt-4">
									<div className="flex justify-between items-center text-lg font-bold">
										<span className="text-gray-900">Tổng cộng:</span>
										<span className="text-blue-700">
											{formatCurrency(total)}
										</span>
									</div>
								</div>

								{/* Important Notes */}
								{settings?.checkoutNotice && (
									<div className="mt-6 p-4 bg-warning-50 border border-warning-200 rounded-lg">
										<h4 className="font-semibold text-warning-800 mb-2">
											<i className="fas fa-info-circle mr-1"></i>
											Lưu ý quan trọng:
										</h4>
										<MarkdownContent className="text-warning-700 text-sm">
											{settings.checkoutNotice}
										</MarkdownContent>
									</div>
								)}

								{/* Submit Button */}
								<div className="mt-6">
									{pricingError && (
										<div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
											<span>Không tính được giá, vui lòng thử lại</span>
											<button
												type="button"
												onClick={checkForCombos}
												disabled={comboDetection.isChecking}
												className="btn-secondary px-3 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
											>
												Thử lại
											</button>
										</div>
									)}
									<button
										type="submit"
										form="checkout-form"
										disabled={isSubmitting || comboDetection.isChecking || pricingError}
										className="btn-success w-full text-lg py-3 disabled:opacity-50 disabled:cursor-not-allowed"
									>
										{isSubmitting ? (
											<LoadingSpinner size="small" text="Đang xử lý..." />
										) : (
											<>
												<i className="fas fa-check mr-2"></i>
												Xác nhận đặt hàng
											</>
										)}
									</button>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

export default CheckoutPage;
