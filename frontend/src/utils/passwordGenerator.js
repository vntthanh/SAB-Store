/**
 * Client-side password generation utilities
 * Generates secure random passwords that meet validation requirements
 */

import { MIN_PASSWORD_LENGTH } from './passwordValidator';

/**
 * Generate a simple password that meets basic requirements
 * (lowercase, uppercase, minimum length)
 * @param {number} length - Password length (minimum MIN_PASSWORD_LENGTH, default 8)
 * @returns {string} Generated password
 */
export function generateSimplePassword(length = MIN_PASSWORD_LENGTH) {
	// Ensure minimum length
	if (length < MIN_PASSWORD_LENGTH) length = MIN_PASSWORD_LENGTH;

	// Character sets (no special chars for simplicity)
	const lowercase = 'abcdefghijklmnopqrstuvwxyz';
	const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	const numbers = '0123456789';

	// Ensure at least one character from each required set
	let password = '';
	password += getRandomChar(lowercase);
	password += getRandomChar(uppercase);
	password += getRandomChar(numbers);

	// Fill remaining length with random characters
	const allChars = lowercase + uppercase + numbers;
	for (let i = password.length; i < length; i++) {
		password += getRandomChar(allChars);
	}

	// Shuffle the password
	return shuffleString(password);
}

/**
 * Get a random character from a string
 * @param {string} str - Source string
 * @returns {string} Random character
 */
function getRandomChar(str) {
	return str.charAt(Math.floor(Math.random() * str.length));
}

/**
 * Shuffle a string randomly
 * @param {string} str - String to shuffle
 * @returns {string} Shuffled string
 */
function shuffleString(str) {
	const array = str.split('');
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
	return array.join('');
}
