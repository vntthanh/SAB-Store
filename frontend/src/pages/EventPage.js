import React, { useState, useEffect, useCallback, useRef } from 'react';
import { STUDENT_ID_PATTERN, STUDENT_ID_HINT } from '../utils/student-id';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { productService, orderService, comboService, formatCurrency, PRICE_CHANGED } from '../services/api';
import LoadingSpinner from '../components/LoadingSpinner';
import MarkdownContent from '../components/MarkdownContent';
import usePublicSettings from '../hooks/usePublicSettings';
import useFieldErrors from '../hooks/use-field-errors';
import FormField from '../components/form/FormField';

// Client rules mirror validateOrder in backend/middleware/validation.js (the server stays authoritative).
// The student-ID format is only enforced for HCMUS students here; other schools use their own formats.
const EVENT_RULES = {
	school: (value) => (value ? null : 'Vui lòng chọn trường của bạn'),
	customSchool: (value, values) => (
		values.school === 'other' && !value.trim() ? 'Vui lòng nhập tên trường của bạn' : null
	),
	studentId: (value, values) => {
		const v = value.trim();
		if (!v) return 'Mã số sinh viên là bắt buộc';
		if (values.school === 'HCMUS' && !STUDENT_ID_PATTERN.test(v)) return STUDENT_ID_HINT;
		return null;
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

	const { errors, validateField, onFieldChange, validateAll, setServerErrors, focusFirstError } = useFieldErrors(EVENT_RULES);
	const formRef = useRef(null);
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
		const next = { ...formData, [name]: value };
		setFormData(next);
		onFieldChange(name, value, next);

		// These rules read the chosen school, so they must be re-checked when it changes.
		if (name === 'school') {
			onFieldChange('studentId', next.studentId, next);
			onFieldChange('customSchool', next.customSchool, next);
		}
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
			if (error.status === 400 && error.fieldErrors?.length) {
				const leftovers = setServerErrors(error);
				if (leftovers.length < error.fieldErrors.length) focusFirstError(formRef);
				if (leftovers.length > 0) toast.error(leftovers.map(l => l.message).join('. '));
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

					<form id="event-form" ref={formRef} onSubmit={handleSubmit} noValidate className="p-6 space-y-6">
						<FormField
							id="school"
							label="Bạn là sinh viên trường" required
							error={errors.school}
						>
							<select
								name="school"
								value={formData.school}
								onChange={handleInputChange}
								onBlur={handleBlur}
								className="form-input"
							>
								<option value="">Chọn trường của bạn</option>
								<option value="HCMUS">Trường Đại học Khoa học tự nhiên, ĐHQG-HCM</option>
								<option value="other">Trường khác</option>
							</select>
						</FormField>

						{formData.school === 'other' && (
							<FormField
								id="customSchool"
								label="Tên trường" required
								error={errors.customSchool}
							>
								<input
									type="text"
									name="customSchool"
									value={formData.customSchool}
									onChange={handleInputChange}
									onBlur={handleBlur}
									placeholder="Nhập tên trường của bạn"
									className="form-input"
									maxLength="100"
								/>
							</FormField>
						)}

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
							hint="Email sẽ được sử dụng để gửi xác nhận vé tham dự"
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