import React, { useState, useRef } from 'react';
import { toast } from 'react-toastify';
import Swal from 'sweetalert2';
import { validatePassword, MIN_PASSWORD_LENGTH } from '../utils/passwordValidator';
import PasswordStrengthIndicator from './PasswordStrengthIndicator';
import RandomPasswordButton from './RandomPasswordButton';
import useFieldErrors from '../hooks/use-field-errors';
import FormField from './form/FormField';
import { adminService, sellerService } from '../services/api';

const CHANGE_PASSWORD_RULES = {
	currentPassword: (value) => (value ? null : 'Mật khẩu hiện tại là bắt buộc'),
	newPassword: (value) => {
		const validation = validatePassword(value);
		if (!validation.isValid) return validation.errors[0];
		return value.trim().length < MIN_PASSWORD_LENGTH
			? `Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự`
			: null;
	},
	confirmPassword: (value, values) => {
		if (!value) return 'Vui lòng xác nhận mật khẩu mới';
		return value === values.newPassword ? null : 'Mật khẩu xác nhận không khớp';
	}
};

const EMPTY_FORM = { currentPassword: '', newPassword: '', confirmPassword: '' };

// Mounted only while the modal is open, so closing it also discards typed passwords and errors.
const ChangePasswordModal = ({ userType, title, onClose }) => {
	const [formData, setFormData] = useState(EMPTY_FORM);
	const [loading, setLoading] = useState(false);
	const { errors, validateField, onFieldChange, validateAll, setServerErrors, focusFirstError } = useFieldErrors(CHANGE_PASSWORD_RULES);
	const formRef = useRef(null);

	const handleChange = (name, value) => {
		const next = { ...formData, [name]: value };
		setFormData(next);
		onFieldChange(name, value, next);
		// The confirmation is compared against the new password, so it follows it.
		if (name === 'newPassword') onFieldChange('confirmPassword', next.confirmPassword, next);
	};

	const handleInputChange = (e) => handleChange(e.target.name, e.target.value);

	const handleBlur = (e) => validateField(e.target.name, e.target.value, formData);

	const handlePasswordGenerated = (newPassword) => {
		// Confirmation is cleared to force re-entry.
		const next = { ...formData, newPassword, confirmPassword: '' };
		setFormData(next);
		onFieldChange('newPassword', newPassword, next);
		onFieldChange('confirmPassword', '', next);
	};

	const handleSubmit = async (e) => {
		e.preventDefault();

		if (!validateAll(formData)) {
			focusFirstError(formRef);
			return;
		}

		try {
			setLoading(true);

			const service = userType === 'admin' ? adminService : sellerService;
			const result = await service.changePassword(
				formData.currentPassword,
				formData.newPassword
			);

			if (result.success) {
				toast.success('Đổi mật khẩu thành công');
				onClose();

				// Show success message and suggest re-login
				Swal.fire({
					title: 'Đổi mật khẩu thành công!',
					text: 'Vì lý do bảo mật, phiên đăng nhập khác sẽ bị đăng xuất. Bạn có thể tiếp tục sử dụng phiên này.',
					icon: 'success',
					confirmButtonText: 'Đã hiểu'
				});
				return;
			}

			throw new Error(result.message);
		} catch (error) {
			console.error('Error changing password:', error);
			setLoading(false);
			// Reasons for known fields show under them; anything else (or a non-validation failure) is a toast.
			if (!error.fieldErrors?.length) {
				toast.error(error.message || 'Lỗi khi đổi mật khẩu');
				return;
			}
			setServerErrors(error).forEach(({ message }) => toast.error(message));
			focusFirstError(formRef);
		}
	};

	const passwordsMatch = formData.confirmPassword && formData.newPassword === formData.confirmPassword;

	return (
		<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
			<div className="bg-white rounded-lg max-w-md w-full">
				<div className="p-6">
					<div className="flex justify-between items-center mb-6">
						<h2 className="text-xl font-semibold text-gray-900">
							{title}
						</h2>
						<button
							type="button"
							onClick={onClose}
							className="text-gray-500 hover:text-gray-700"
						>
							<i className="fas fa-times text-xl"></i>
						</button>
					</div>

					<form ref={formRef} onSubmit={handleSubmit} noValidate className="space-y-4">
						<FormField
							id="currentPassword"
							label="Mật khẩu hiện tại" required
							error={errors.currentPassword}
						>
							<input
								type="password"
								name="currentPassword"
								value={formData.currentPassword}
								onChange={handleInputChange}
								onBlur={handleBlur}
								className="form-input"
								placeholder="Nhập mật khẩu hiện tại"
								autoComplete="current-password"
							/>
						</FormField>

						<div>
							<div className="flex items-start space-x-2">
								<div className="flex-1">
									<FormField
										id="newPassword"
										label="Mật khẩu mới" required
										error={errors.newPassword}
									>
										<input
											type="password"
											name="newPassword"
											value={formData.newPassword}
											onChange={handleInputChange}
											onBlur={handleBlur}
											className="form-input"
											placeholder="Nhập mật khẩu mới"
											autoComplete="new-password"
										/>
									</FormField>
								</div>
								{/* mt-7 = label height + gap, so the button lines up with the input */}
								<div className="mt-7">
									<RandomPasswordButton
										onPasswordGenerated={handlePasswordGenerated}
										length={10}
										title="Tạo mật khẩu ngẫu nhiên"
									/>
								</div>
							</div>

							{/* Password Strength Indicator */}
							<PasswordStrengthIndicator
								password={formData.newPassword}
								showRequirements={true}
							/>
						</div>

						<FormField
							id="confirmPassword"
							label="Xác nhận mật khẩu mới" required
							error={errors.confirmPassword}
							hint={passwordsMatch ? (
								<span className="text-green-600">
									<i className="fas fa-check-circle mr-1" aria-hidden="true"></i>
									Mật khẩu xác nhận khớp
								</span>
							) : undefined}
						>
							<input
								type="password"
								name="confirmPassword"
								value={formData.confirmPassword}
								onChange={handleInputChange}
								onBlur={handleBlur}
								className="form-input"
								placeholder="Nhập lại mật khẩu mới"
								autoComplete="new-password"
							/>
						</FormField>

						<div className="flex justify-end space-x-3 pt-4">
							<button
								type="button"
								onClick={onClose}
								className="btn-secondary"
								disabled={loading}
							>
								Hủy
							</button>
							<button
								type="submit"
								className="btn-primary"
								disabled={loading}
							>
								{loading ? (
									<>
										<i className="fas fa-spinner fa-spin mr-2"></i>
										Đang xử lý...
									</>
								) : (
									'Đổi mật khẩu'
								)}
							</button>
						</div>
					</form>

					{/* Security Notice */}
					<div className="mt-4 p-3 bg-blue-50 rounded-md">
						<div className="flex">
							<i className="fas fa-info-circle text-blue-400 mr-2 mt-0.5"></i>
							<div className="text-sm text-blue-700">
								<p className="font-medium">Yêu cầu mật khẩu bảo mật:</p>
								<ul className="list-disc list-inside mt-1 space-y-1">
									<li>Ít nhất {MIN_PASSWORD_LENGTH} ký tự</li>
									<li>Chứa chữ thường và chữ hoa</li>
									<li>Không sử dụng mật khẩu phổ biến</li>
									<li>Tất cả phiên đăng nhập khác sẽ bị đăng xuất</li>
								</ul>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

const ChangePassword = ({ userType = 'admin', title = 'Đổi mật khẩu' }) => {
	const [showModal, setShowModal] = useState(false);

	return (
		<>
			{/* Trigger Button */}
			<button
				onClick={() => setShowModal(true)}
				className="btn-primary"
			>
				<i className="fas fa-key mr-2"></i>
				{title}
			</button>

			{showModal && (
				<ChangePasswordModal
					userType={userType}
					title={title}
					onClose={() => setShowModal(false)}
				/>
			)}
		</>
	);
};

export default ChangePassword;
