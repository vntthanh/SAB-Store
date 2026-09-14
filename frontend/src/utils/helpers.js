/**
 * Format Vietnamese currency
 * @param {number} amount 
 * @returns {string} Formatted currency string
 */
export const formatCurrency = (amount) => {
	return new Intl.NumberFormat('vi-VN', {
		style: 'currency',
		currency: 'VND'
	}).format(amount);
};

/**
 * Format date for Vietnamese locale
 * @param {Date} date 
 * @returns {string} Formatted date string
 */
export const formatDate = (date) => {
	return new Intl.DateTimeFormat('vi-VN', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).format(new Date(date));
};

/**
 * Validate email format
 * @param {string} email 
 * @returns {boolean}
 */
export const isValidEmail = (email) => {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email);
};

/**
 * Sanitize string to prevent XSS
 * @param {string} str 
 * @returns {string}
 */
export const sanitizeString = (str) => {
	if (typeof str !== 'string') return '';
	return str.replace(/[<>]/g, '');
};

/**
 * Calculate total from items array
 * @param {Array} items - Array of items with price and quantity
 * @returns {number}
 */
export const calculateTotal = (items) => {
	return items.reduce((total, item) => {
		return total + (item.price * item.quantity);
	}, 0);
};

/**
 * Get the correct image URL for display
 * @param {string} imageUrl - The image URL from database
 * @returns {string} - The correct URL for displaying the image
 */
export const getImageUrl = (imageUrl) => {
	if (!imageUrl) {
		return '/fallback-product.png';
	}

	// If it's already a full URL (starts with http), return as is
	if (imageUrl.startsWith('http')) {
		return imageUrl;
	}

	// Relative paths (e.g. /uploads/...) are already same-origin: frontend
	// nginx proxies them directly, no domain needs to be prepended (AD-3).
	return imageUrl.startsWith('/') ? imageUrl : `/${imageUrl}`;
};
