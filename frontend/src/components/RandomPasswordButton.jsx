import React from 'react';
import { toast } from 'react-toastify';
import { generateSimplePassword } from '../utils/passwordGenerator';

/**
 * Reusable Random Password Generation Button Component
 * Generates a secure random password locally and updates the target input field
 */
const RandomPasswordButton = ({
	onPasswordGenerated,
	length = 10,
	className = '',
	title = 'Tạo mật khẩu ngẫu nhiên',
	showToast = true,
	disabled = false
}) => {
	const handleGeneratePassword = () => {
		try {
			const newPassword = generateSimplePassword(length);

			// Call the callback function with the generated password
			if (onPasswordGenerated) {
				onPasswordGenerated(newPassword);
			}

			// Show success notification
			if (showToast) {
				toast.success('Đã tạo mật khẩu ngẫu nhiên');
			}
		} catch (error) {
			console.error('Error generating password:', error);
			if (showToast) {
				toast.error('Lỗi khi tạo mật khẩu ngẫu nhiên');
			}
		}
	};

	return (
		<button
			type="button"
			onClick={handleGeneratePassword}
			disabled={disabled}
			className={`px-3 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
			title={title}
		>
			<i className="fas fa-random"></i>
		</button>
	);
};

export default RandomPasswordButton;
