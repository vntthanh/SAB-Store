/**
 * Client-side password validation utilities
 * Mirrors the backend validation for real-time feedback
 */

import {
	MIN_PASSWORD_LENGTH,
	PASSWORD_STRENGTH,
	isCommonPassword,
	calculatePasswordStrength,
} from '@sab/shared';

export { MIN_PASSWORD_LENGTH, PASSWORD_STRENGTH };

/**
 * Validate password and return detailed feedback
 * @param {string} password - The password to validate
 * @returns {Object} Validation result with requirements check
 */
export function validatePassword(password) {
	const requirements = {
		length: false,
		lowercase: false,
		uppercase: false,
		notCommon: true
	};

	const errors = [];

	if (!password || typeof password !== 'string') {
		return {
			isValid: false,
			requirements,
			errors: ['Mật khẩu là bắt buộc'],
			strength: PASSWORD_STRENGTH.WEAK
		};
	}

	const trimmedPassword = password.trim();

	// Length check
	requirements.length = trimmedPassword.length >= MIN_PASSWORD_LENGTH;
	if (!requirements.length) {
		errors.push(`Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự`);
	}

	// Lowercase check
	requirements.lowercase = /[a-z]/.test(trimmedPassword);
	if (!requirements.lowercase) {
		errors.push('Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)');
	}

	// Uppercase check
	requirements.uppercase = /[A-Z]/.test(trimmedPassword);
	if (!requirements.uppercase) {
		errors.push('Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)');
	}

	// Common password check
	requirements.notCommon = !isCommonPassword(trimmedPassword);
	if (!requirements.notCommon) {
		errors.push('Mật khẩu này quá phổ biến và không an toàn');
	}

	const isValid = Object.values(requirements).every(req => req);
	const strength = calculatePasswordStrength(trimmedPassword);

	return {
		isValid,
		requirements,
		errors,
		strength
	};
}

/**
 * Get strength color for UI display
 * @param {string} strength 
 * @returns {string}
 */
export function getStrengthColor(strength) {
	switch (strength) {
		case PASSWORD_STRENGTH.WEAK:
			return 'text-red-600';
		case PASSWORD_STRENGTH.MEDIUM:
			return 'text-yellow-600';
		case PASSWORD_STRENGTH.STRONG:
			return 'text-green-600';
		default:
			return 'text-gray-400';
	}
}

/**
 * Get strength text for UI display
 * @param {string} strength 
 * @returns {string}
 */
export function getStrengthText(strength) {
	switch (strength) {
		case PASSWORD_STRENGTH.WEAK:
			return 'Yếu';
		case PASSWORD_STRENGTH.MEDIUM:
			return 'Trung bình';
		case PASSWORD_STRENGTH.STRONG:
			return 'Mạnh';
		default:
			return 'Không xác định';
	}
}
