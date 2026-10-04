import React, { useState, useEffect, useCallback, useRef } from 'react';
import { STUDENT_ID_PATTERN, STUDENT_ID_HINT } from '../utils/student-id';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { productService, orderService, comboService, formatCurrency, PRICE_CHANGED } from '../services/api';
import LoadingSpinner from '../components/LoadingSpinner';
import MarkdownContent from '../components/MarkdownContent';
import usePublicSettings from '../hooks/usePublicSettings';

const EventPage = () => {
	const settings = usePublicSettings();
	const navigate = useNavigate();
	const [product, setProduct] = useState(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState(null);

	const [formData, setFormData] = useState({
		studentId: '',
		fullName: '',
		email: '',
		phoneNumber: '',
		additionalNote: '',
		school: '',
		customSchool: ''
	});

	const [quantity, setQuantity] = useState(1);

	const [errors, setErrors] = useState({});
	const [isSubmitting, setIsSubmitting] = useState(false);
	// Server-computed total for the chosen quantity (combos included); this is
	// the figure shown and the figure sent back as expectedTotal.
	const [pricing, setPricing] = useState(null);
	const [loadingPricing, setLoadingPricing] = useState(false);

	// True while the latest preview failed; submit stays off until a retry works.
	const [pricingError, setPricingError] = useState(false);
	// Only the newest request may update state, and the loading flag stays on
	// until that newest request settles.
	const pricingRequestId = useRef(0);

	const loadPricing = useCallback(async () => {
		if (!product) return;
		const requestId = ++pricingRequestId.current;
		setLoadingPricing(true);
		setPricingError(false);
		try {
			const result = await comboService.calculatePricing([{ productId: product._id, quantity }]);
			if (requestId !== pricingRequestId.current) return;
			if (!result.success) throw new Error(result.message || 'Không tính được giá');
			setPricing(result.data);
		} catch (err) {
			if (requestId !== pricingRequestId.current) return;
			setPricing(null);
			setPricingError(true);
			toast.error(err.message);
		} finally {
			if (requestId === pricingRequestId.current) setLoadingPricing(false);
		}
	}, [product, quantity]);

	useEffect(() => {
		loadPricing();
	}, [loadPricing]);

	// Fetch the first available product
	useEffect(() => {
		const fetchFirstProduct = async () => {
			try {
				setLoading(true);
				setError(null);

				const response = await productService.getProducts({ available: true });

				if (response.success && response.data.products.length > 0) {
					// Get the first product
					setProduct(response.data.products[0]);
				} else {
					setError('Không có sản phẩm nào khả dụng');
				}
			} catch (err) {
				setError(err.message);
				toast.error(err.message);
			} finally {
				setLoading(false);
			}
		};

		fetchFirstProduct();
	}, []);

	const handleInputChange = (e) => {
		const { name, value } = e.target;
		setFormData(prev => ({
			...prev,
			[name]: value
		}));

		// Clear error when user starts typing
		if (errors[name]) {
			setErrors(prev => ({
				...prev,
				[name]: ''
			}));
		}
	};

	const validateForm = () => {
		// Phone number validation
		const newErrors = {};
		if (!formData.phoneNumber.trim()) {
			newErrors.phoneNumber = 'Số điện thoại là bắt buộc';
		} else if (!/^0[0-9]{9}$/.test(formData.phoneNumber.trim())) {
			newErrors.phoneNumber = 'Số điện thoại không hợp lệ';
		}

		// School validation
		if (!formData.school) {
			newErrors.school = 'Vui lòng chọn trường của bạn';
		} else if (formData.school === 'other' && !formData.customSchool.trim()) {
			newErrors.school = 'Vui lòng nhập tên trường của bạn';
		}

		// Student ID validation - always required, but regex only for HCMUS
		if (!formData.studentId.trim()) {
			newErrors.studentId = 'Mã số sinh viên là bắt buộc';
		} else if (formData.school === 'HCMUS') {
			if (!STUDENT_ID_PATTERN.test(formData.studentId.trim())) {
				newErrors.studentId = STUDENT_ID_HINT;
			}
		}

		// Full name validation
		if (!formData.fullName.trim()) {
			newErrors.fullName = 'Họ tên là bắt buộc';
		} else if (formData.fullName.trim().length < 2) {
			newErrors.fullName = 'Họ tên phải có ít nhất 2 ký tự';
		} else if (!/^[a-zA-ZÀ-ỹ\s]+$/.test(formData.fullName.trim())) {
			newErrors.fullName = 'Họ tên chỉ được chứa chữ cái và khoảng trắng';
		}

		// Email validation
		if (!formData.email.trim()) {
			newErrors.email = 'Email là bắt buộc';
		} else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email.trim())) {
			newErrors.email = 'Email không hợp lệ';
		}

		// Additional note validation (optional but length check)
		if (formData.additionalNote.length > 500) {
			newErrors.additionalNote = 'Ghi chú không được vượt quá 500 ký tự';
		}

		setErrors(newErrors);
		return Object.keys(newErrors).length === 0;
	};

	const handleSubmit = async (e) => {
		e.preventDefault();

		if (!validateForm()) {
			toast.error('Vui lòng kiểm tra lại thông tin đã nhập');
			return;
		}

		if (!product) {
			toast.error('Không có sản phẩm để đặt hàng');
			return;
		}

		if (!pricing) {
			toast.error('Chưa tính được giá, vui lòng thử lại');
			return;
		}

		setIsSubmitting(true);

		try {
			const orderData = {
				studentId: formData.studentId.trim(),
				fullName: formData.fullName.trim(),
				email: formData.email.trim().toLowerCase(),
				phoneNumber: formData.phoneNumber.trim(),
				school: formData.school === 'other' ? formData.customSchool.trim() : formData.school,
				additionalNote: formData.additionalNote.trim(),
				items: [{
					productId: product._id,
					quantity: quantity
				}],
				expectedTotal: pricing.totalAmount
			};

			const response = await orderService.createOrder(orderData);

			if (response.success) {
				toast.success('Đặt vé tham dự thành công!');

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
				toast.warning('Giá vừa thay đổi, vui lòng xem lại giá trước khi đăng ký');
				loadPricing();
				return;
			}
			console.error('Order creation error:', error);
			toast.error(error.message || 'Có lỗi xảy ra khi đặt vé tham dự');
		} finally {
			setIsSubmitting(false);
		}
	};

	if (loading) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<LoadingSpinner size="large" text="Đang tải thông tin vé tham dự..." />
			</div>
		);
	}

	if (error || !product) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<div className="text-center">
					<i className="fas fa-exclamation-triangle text-6xl text-danger-500 mb-4"></i>
					<h2 className="text-2xl font-bold text-gray-900 mb-2">Có lỗi xảy ra</h2>
					<p className="text-gray-600 mb-4">{error || 'Không có vé tham dự nào khả dụng'}</p>
					<button
						onClick={() => window.location.reload()}
						className="btn-primary"
					>
						Thử lại
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="container mx-auto px-4 py-8">
			<div className="max-w-2xl mx-auto">
				{/* Header */}
				<div className="text-center mb-8">
					<h1 className="text-3xl font-bold text-gray-900 mb-2">
						<i className="fas fa-calendar-check mr-3 text-blue-700"></i>
						Đăng ký tham dự Workshop
					</h1>
					<p className="text-gray-600">
						Điền thông tin để đăng ký vé tham dự workshop
					</p>
				</div>

				{/* Event Info Card */}
				<div className="card mb-6">
					<div className="bg-blue-50 px-6 py-4 border-b border-blue-100">
						<h2 className="text-xl font-semibold text-gray-900">
							Thông tin vé tham dự
						</h2>
					</div>

					<div className="p-6">
						{/* Title */}
						<div className="mb-3">
							<h3 className="font-semibold text-gray-900 text-lg text-center">{product.name}</h3>
						</div>

						{/* Description spanning full width */}
						{product.description && (
							<p className="text-gray-600 text-sm mb-3" style={{ whiteSpace: 'pre-line' }}>{product.description}</p>
						)}

						{/* Product Image */}
						{product.imageUrl && (
							<div className="mb-3">
								<img
									src={product.imageUrl}
									alt={product.name}
									className="w-full max-w-md mx-auto rounded-lg shadow-sm"
									onError={(e) => {
										e.target.style.display = 'none';
									}}
								/>
							</div>
						)}

						{/* Quantity Controls */}
						<div className="flex items-center justify-center mt-4 mb-4">
							<label htmlFor="quantity" className="text-sm text-gray-600 mr-3">Số lượng bạn tham gia trong cùng một buổi:</label>
							<input
								type="number"
								id="quantity"
								name="quantity"
								value={quantity}
								onChange={(e) => {
									const value = parseInt(e.target.value, 10);
									if (!isNaN(value) && value >= 1 && value <= 99) {
										setQuantity(value);
									}
								}}
								min="1"
								max="99"
								className="form-input w-20 text-center"
							/>
						</div>

						{/* Price below quantity */}
						<div className="text-center">
							<p className="text-2xl font-bold text-blue-700">
								{loadingPricing || !pricing ? '...' : formatCurrency(pricing.totalAmount)}
							</p>
							<p className="text-sm text-gray-500">
								{formatCurrency(product.price)} / bạn
							</p>
						</div>
					</div>
				</div>

				{/* Registration Form */}
				<div className="card">
					<div className="bg-blue-50 px-6 py-4 border-b border-blue-100">
						<h2 className="text-xl font-semibold text-gray-900">
							Thông tin nhận vé
						</h2>
					</div>

					<form id="event-form" onSubmit={handleSubmit} className="p-6 space-y-6">
						{/* School Selection */}
						<div>
							<label htmlFor="school" className="block text-sm font-medium text-gray-700 mb-2">
								Bạn là sinh viên trường <span className="text-danger-500">*</span>
							</label>
							<select
								id="school"
								name="school"
								value={formData.school}
								onChange={handleInputChange}
								className={`form-input ${errors.school ? 'form-input-error' : ''}`}
							>
								<option value="">Chọn trường của bạn</option>
								<option value="HCMUS">Trường Đại học Khoa học tự nhiên, ĐHQG-HCM</option>
								<option value="other">Trường khác</option>
							</select>
							{formData.school === 'other' && (
								<input
									type="text"
									name="customSchool"
									value={formData.customSchool}
									onChange={handleInputChange}
									placeholder="Nhập tên trường của bạn"
									className="form-input mt-2"
									maxLength="100"
								/>
							)}
							{errors.school && (
								<p className="text-danger-500 text-sm mt-1">
									<i className="fas fa-exclamation-circle mr-1"></i>
									{errors.school}
								</p>
							)}
						</div>

						{/* Student ID - Always required */}
						<div>
							<label htmlFor="studentId" className="block text-sm font-medium text-gray-700 mb-2">
								Mã số sinh viên <span className="text-danger-500">*</span>
							</label>
							<input
								type="text"
								id="studentId"
								name="studentId"
								value={formData.studentId}
								onChange={handleInputChange}
								placeholder="Nhập mã số sinh viên"
								className={`form-input ${errors.studentId ? 'form-input-error' : ''}`}
								maxLength="20"
							/>
							{errors.studentId && (
								<p className="text-danger-500 text-sm mt-1">
									<i className="fas fa-exclamation-circle mr-1"></i>
									{errors.studentId}
								</p>
							)}
						</div>

						{/* Full Name */}
						<div>
							<label htmlFor="fullName" className="block text-sm font-medium text-gray-700 mb-2">
								Họ tên <span className="text-danger-500">*</span>
							</label>
							<input
								type="text"
								id="fullName"
								name="fullName"
								value={formData.fullName}
								onChange={handleInputChange}
								placeholder="Nhập họ tên đầy đủ"
								className={`form-input ${errors.fullName ? 'form-input-error' : ''}`}
								maxLength="100"
							/>
							{errors.fullName && (
								<p className="text-danger-500 text-sm mt-1">
									<i className="fas fa-exclamation-circle mr-1"></i>
									{errors.fullName}
								</p>
							)}
						</div>

						{/* Email */}
						<div>
							<label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
								Email <span className="text-danger-500">*</span>
							</label>
							<input
								type="email"
								id="email"
								name="email"
								value={formData.email}
								onChange={handleInputChange}
								placeholder="Nhập địa chỉ email"
								className={`form-input ${errors.email ? 'form-input-error' : ''}`}
								maxLength="100"
							/>
							{errors.email && (
								<p className="text-danger-500 text-sm mt-1">
									<i className="fas fa-exclamation-circle mr-1"></i>
									{errors.email}
								</p>
							)}
							<p className="text-gray-500 text-sm mt-1">
								Email sẽ được sử dụng để gửi xác nhận vé tham dự
							</p>
						</div>

						{/* Phone Number */}
						<div>
							<label htmlFor="phoneNumber" className="block text-sm font-medium text-gray-700 mb-2">
								Số điện thoại <span className="text-danger-500">*</span>
							</label>
							<input
								type="text"
								id="phoneNumber"
								name="phoneNumber"
								value={formData.phoneNumber}
								onChange={handleInputChange}
								placeholder="Nhập số điện thoại"
								className={`form-input ${errors.phoneNumber ? 'form-input-error' : ''}`}
								maxLength="10"
							/>
							{errors.phoneNumber && (
								<p className="text-danger-500 text-sm mt-1">
									<i className="fas fa-exclamation-circle mr-1"></i>
									{errors.phoneNumber}
								</p>
							)}
							<p className="text-gray-500 text-sm mt-1">
								Ưu tiên số điện thoại có sử dụng Zalo.
							</p>
						</div>

						{/* Additional Note */}
						<div>
							<label htmlFor="additionalNote" className="block text-sm font-medium text-gray-700 mb-2">
								Ghi chú
							</label>
							<textarea
								id="additionalNote"
								name="additionalNote"
								value={formData.additionalNote}
								onChange={handleInputChange}
								placeholder="Nếu còn điều gì cần lưu ý với SAB, bạn hãy điền vào đây nhé!"
								rows="3"
								className={`form-input ${errors.additionalNote ? 'form-input-error' : ''}`}
								maxLength="500"
							/>
							<div className="flex justify-between mt-1">
								{errors.additionalNote && (
									<p className="text-danger-500 text-sm">
										<i className="fas fa-exclamation-circle mr-1"></i>
										{errors.additionalNote}
									</p>
								)}
								<p className="text-gray-500 text-sm ml-auto">
									{formData.additionalNote.length}/500
								</p>
							</div>
						</div>
					</form>
				</div>

				{/* Important Notes */}
				{settings?.eventNotice && (
					<div className="mt-6 p-4 bg-warning-50 border border-warning-200 rounded-lg">
						<h4 className="font-semibold text-warning-800 mb-2">
							<i className="fas fa-info-circle mr-1"></i>
							Lưu ý quan trọng:
						</h4>
						<MarkdownContent className="text-warning-700 text-sm">
							{settings.eventNotice}
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
								onClick={loadPricing}
								disabled={loadingPricing}
								className="btn-secondary px-3 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								Thử lại
							</button>
						</div>
					)}
					<button
						type="submit"
						form="event-form"
						disabled={isSubmitting || loadingPricing || !pricing}
						className="btn-success w-full text-lg py-3 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{isSubmitting ? (
							<LoadingSpinner size="small" text="Đang xử lý..." />
						) : (
							<>
								<i className="fas fa-check mr-2"></i>
								Xác nhận đăng ký ({quantity} bạn)
							</>
						)}
					</button>
				</div>
			</div>
		</div>
	);
};

export default EventPage;