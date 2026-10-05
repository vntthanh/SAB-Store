/**
 * Password validation utility with comprehensive security checks
 * 
 * Requirements:
 * - Length within the shared minimum and maximum
 * - Contains lowercase letters
 * - Contains uppercase letters  
 * - Prevents common passwords
 */

const {
	COMMON_PASSWORDS,
	PASSWORD_STRENGTH,
	MIN_PASSWORD_LENGTH,
	MAX_PASSWORD_LENGTH,
	isCommonPassword,
	hasSequentialChars,
	hasRepeatedChars,
	calculatePasswordStrength,
} = require('@sab/shared');

/**
 * Validate password strength based on requirements
 * @param {string} password - The password to validate
 * @returns {Object} Validation result with success, errors, and strength
 */
function validatePassword(password) {
	const errors = [];
	const warnings = [];

	// Check if password exists
	if (!password || typeof password !== 'string') {
		return {
			success: false,
			errors: ['Mật khẩu là bắt buộc'],
			warnings: [],
			strength: PASSWORD_STRENGTH.WEAK
		};
	}

	// Remove leading/trailing whitespace for validation
	const trimmedPassword = password.trim();

	// Length validation
	// Better Auth refuses anything shorter (minPasswordLength in lib/auth.js); a
	// lower bound here would pass validation and then fail inside the auth call.
	if (trimmedPassword.length < MIN_PASSWORD_LENGTH) {
		errors.push(`Mật khẩu phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự`);
	}

	// Maximum length check (prevent DoS attacks)
	if (trimmedPassword.length > MAX_PASSWORD_LENGTH) {
		errors.push(`Mật khẩu không được vượt quá ${MAX_PASSWORD_LENGTH} ký tự`);
	}

	// Lowercase letter check
	if (!/[a-z]/.test(trimmedPassword)) {
		errors.push('Mật khẩu phải chứa ít nhất 1 chữ cái thường (a-z)');
	}

	// Uppercase letter check
	if (!/[A-Z]/.test(trimmedPassword)) {
		errors.push('Mật khẩu phải chứa ít nhất 1 chữ cái hoa (A-Z)');
	}

	// Common password check (case insensitive)
	if (isCommonPassword(trimmedPassword)) {
		errors.push('Mật khẩu này quá phổ biến và không an toàn. Vui lòng chọn mật khẩu khác');
	}

	// Sequential characters check (e.g., 123456, abcdef)
	if (hasSequentialChars(trimmedPassword)) {
		warnings.push('Mật khẩu chứa ký tự liên tiếp, nên tránh để tăng bảo mật');
	}

	// Repeated characters check (e.g., 111111, aaaaaa)
	if (hasRepeatedChars(trimmedPassword)) {
		warnings.push('Mật khẩu chứa nhiều ký tự giống nhau, nên tránh để tăng bảo mật');
	}

	// Calculate password strength
	const strength = calculatePasswordStrength(trimmedPassword);

	return {
		success: errors.length === 0,
		errors,
		warnings,
		strength
	};
}

/**
 * Generate password strength indicators for UI
 * @param {string} password 
 * @returns {Object}
 */
function getPasswordStrengthIndicators(password) {
	const validation = validatePassword(password);

	const indicators = {
		length: password?.length >= MIN_PASSWORD_LENGTH,
		lowercase: /[a-z]/.test(password || ''),
		uppercase: /[A-Z]/.test(password || ''),
		notCommon: !isCommonPassword(password || ''),
		overall: validation.success
	};

	return {
		indicators,
		strength: validation.strength,
		errors: validation.errors,
		warnings: validation.warnings
	};
}

/**
 * Express validator middleware for password validation
 * @param {string} field - The field name to validate (default: 'password')
 * @returns {Array} Express validator rules
 */
function createPasswordValidationRules(field = 'password') {
	const { body } = require('express-validator');

	return [
		body(field)
			.notEmpty()
			.withMessage('Mật khẩu là bắt buộc')
			.isLength({ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH })
			.withMessage(`Mật khẩu phải có từ ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} ký tự`)
			.matches(/[a-z]/)
			.withMessage('Mật khẩu phải chứa ít nhất 1 chữ cái thường')
			.matches(/[A-Z]/)
			.withMessage('Mật khẩu phải chứa ít nhất 1 chữ cái hoa')
			.custom((value) => {
				if (isCommonPassword(value)) {
					throw new Error('Mật khẩu này quá phổ biến và không an toàn');
				}
				return true;
			})
			.trim()
	];
}

module.exports = {
	validatePassword,
	getPasswordStrengthIndicators,
	createPasswordValidationRules,
	PASSWORD_STRENGTH,
	COMMON_PASSWORDS
};
