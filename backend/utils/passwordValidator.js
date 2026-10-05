/**
 * Password validation utility with comprehensive security checks
 * 
 * Requirements:
 * - At least 8 characters
 * - Contains lowercase letters
 * - Contains uppercase letters  
 * - Prevents common passwords
 */

// Common passwords list (top 100 most used passwords)
const COMMON_PASSWORDS = [
	'123456', 'password', '123456789', '12345678', '12345', '1234567',
	'password1', '1234567890', 'qwerty', 'abc123', '111111', '123123',
	'password123', '1234', '123321', 'qwerty123', '000000', 'iloveyou',
	'dragon', 'monkey', 'sunshine', 'princess', 'football', 'charlie',
	'aa123456', 'donald', 'password12', 'qwertyuiop', '654321', 'lovely',
	'7777777', '123qwe', 'maggie', 'qwerty1', '123abc', 'baseball',
	'hello123', 'freedom', 'whatever', 'nicole', '11111111', 'jordan23',
	'superman', 'harley', '1234qwer', 'trustno1', 'ranger', 'master',
	'soccer', 'michael', 'daniel', 'jessica', 'mustang', 'chelsea',
	'batman', 'passw0rd', 'jordan', 'michelle', 'welcome', 'shadow',
	'cookie', 'cheese', 'flower', 'matthew', 'buster', 'summer',
	'tigger', 'robert', 'friend', 'hunter', 'pepper', 'orange',
	'merlin', 'secret', 'diamond', 'chicken', 'access', 'hockey',
	'killer', 'george', 'computer', 'michelle1', 'pepper1', 'purple',
	'master1', 'jesus', 'hello', 'charlie1', 'love', 'secret1',
	'snoopy', 'help', 'banana', 'jordan1', 'saturn', 'black',
	'turtle', 'reddog', 'paris', 'america', 'enter', 'ginger',
	'mother', 'conrad', 'hello1', 'anthony', 'mercedes', 'lucky',
	'player', 'money', 'danielle', 'warrior', 'mario', 'richard',
	'admin', 'root', 'user', 'guest', 'test', 'demo'
];

/**
 * Password strength levels
 */
const PASSWORD_STRENGTH = {
	WEAK: 'weak',
	MEDIUM: 'medium',
	STRONG: 'strong'
};

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

	// Length validation (minimum 8 characters)
	// Better Auth refuses anything shorter (minPasswordLength in lib/auth.js); a
	// lower bound here would pass validation and then fail inside the auth call.
	if (trimmedPassword.length < 8) {
		errors.push('Mật khẩu phải có ít nhất 8 ký tự');
	}

	// Maximum length check (prevent DoS attacks)
	if (trimmedPassword.length > 128) {
		errors.push('Mật khẩu không được vượt quá 128 ký tự');
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
	if (COMMON_PASSWORDS.includes(trimmedPassword.toLowerCase())) {
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
 * Check for sequential characters (123, abc, etc.)
 * @param {string} password 
 * @returns {boolean}
 */
function hasSequentialChars(password) {
	const sequences = [
		'0123456789',
		'abcdefghijklmnopqrstuvwxyz',
		'qwertyuiop',
		'asdfghjkl',
		'zxcvbnm'
	];

	const lowerPassword = password.toLowerCase();

	for (const sequence of sequences) {
		for (let i = 0; i <= sequence.length - 3; i++) {
			const subSeq = sequence.substring(i, i + 3);
			if (lowerPassword.includes(subSeq)) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Check for repeated characters
 * @param {string} password 
 * @returns {boolean}
 */
function hasRepeatedChars(password) {
	// Check for 3 or more repeated characters
	const repeatedPattern = /(.)\1{2,}/;
	return repeatedPattern.test(password);
}

/**
 * Calculate password strength score
 * @param {string} password 
 * @returns {string}
 */
function calculatePasswordStrength(password) {
	let score = 0;

	// Length bonus
	if (password.length >= 8) score += 1;
	if (password.length >= 12) score += 1;

	// Character variety bonus
	if (/[a-z]/.test(password)) score += 1;
	if (/[A-Z]/.test(password)) score += 1;
	if (/[0-9]/.test(password)) score += 1;
	if (/[^a-zA-Z0-9]/.test(password)) score += 1; // Special characters

	// Penalty for common patterns
	if (hasSequentialChars(password)) score -= 1;
	if (hasRepeatedChars(password)) score -= 1;
	if (COMMON_PASSWORDS.includes(password.toLowerCase())) score -= 2;

	// Return strength level
	if (score <= 2) return PASSWORD_STRENGTH.WEAK;
	if (score <= 4) return PASSWORD_STRENGTH.MEDIUM;
	return PASSWORD_STRENGTH.STRONG;
}

/**
 * Generate password strength indicators for UI
 * @param {string} password 
 * @returns {Object}
 */
function getPasswordStrengthIndicators(password) {
	const validation = validatePassword(password);

	const indicators = {
		length: password?.length >= 8,
		lowercase: /[a-z]/.test(password || ''),
		uppercase: /[A-Z]/.test(password || ''),
		notCommon: !COMMON_PASSWORDS.includes((password || '').toLowerCase()),
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
			.isLength({ min: 8, max: 128 })
			.withMessage('Mật khẩu phải có từ 8-128 ký tự')
			.matches(/[a-z]/)
			.withMessage('Mật khẩu phải chứa ít nhất 1 chữ cái thường')
			.matches(/[A-Z]/)
			.withMessage('Mật khẩu phải chứa ít nhất 1 chữ cái hoa')
			.custom((value) => {
				if (COMMON_PASSWORDS.includes(value.toLowerCase())) {
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
