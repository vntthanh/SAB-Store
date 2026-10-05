/**
 * Client-side password validation utilities
 * Mirrors the backend validation for real-time feedback
 */

// Matches Better Auth minPasswordLength in backend/lib/auth.js.
export const MIN_PASSWORD_LENGTH = 8;

// Common passwords list (subset for client-side checking)
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
	'admin', 'root', 'user', 'guest', 'test', 'demo'
];

/**
 * Password strength levels
 */
export const PASSWORD_STRENGTH = {
	WEAK: 'weak',
	MEDIUM: 'medium',
	STRONG: 'strong'
};

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
	requirements.notCommon = !COMMON_PASSWORDS.includes(trimmedPassword.toLowerCase());
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
 * Calculate password strength
 * @param {string} password 
 * @returns {string}
 */
function calculatePasswordStrength(password) {
	let score = 0;

	// Length bonus
	if (password.length >= MIN_PASSWORD_LENGTH) score += 1;
	if (password.length >= 12) score += 1;

	// Character variety
	if (/[a-z]/.test(password)) score += 1;
	if (/[A-Z]/.test(password)) score += 1;
	if (/[0-9]/.test(password)) score += 1;
	if (/[^a-zA-Z0-9]/.test(password)) score += 1;

	// Penalties
	if (hasSequentialChars(password)) score -= 1;
	if (hasRepeatedChars(password)) score -= 1;
	if (COMMON_PASSWORDS.includes(password.toLowerCase())) score -= 2;

	if (score <= 2) return PASSWORD_STRENGTH.WEAK;
	if (score <= 4) return PASSWORD_STRENGTH.MEDIUM;
	return PASSWORD_STRENGTH.STRONG;
}

/**
 * Check for sequential characters
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
	const repeatedPattern = /(.)\1{2,}/;
	return repeatedPattern.test(password);
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
