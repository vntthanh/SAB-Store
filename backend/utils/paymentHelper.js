const Settings = require('../models/Settings');

const { SETTINGS_KEY } = Settings;

/**
 * Convert Vietnamese text to ASCII
 * @param {string} text - Vietnamese text to convert
 * @returns {string} ASCII text
 */
const toAscii = (text) => {
	const vietnameseMap = {
		'à': 'a', 'á': 'a', 'ả': 'a', 'ã': 'a', 'ạ': 'a',
		'ă': 'a', 'ằ': 'a', 'ắ': 'a', 'ẳ': 'a', 'ẵ': 'a', 'ặ': 'a',
		'â': 'a', 'ầ': 'a', 'ấ': 'a', 'ẩ': 'a', 'ẫ': 'a', 'ậ': 'a',
		'è': 'e', 'é': 'e', 'ẻ': 'e', 'ẽ': 'e', 'ẹ': 'e',
		'ê': 'e', 'ề': 'e', 'ế': 'e', 'ể': 'e', 'ễ': 'e', 'ệ': 'e',
		'ì': 'i', 'í': 'i', 'ỉ': 'i', 'ĩ': 'i', 'ị': 'i',
		'ò': 'o', 'ó': 'o', 'ỏ': 'o', 'õ': 'o', 'ọ': 'o',
		'ô': 'o', 'ồ': 'o', 'ố': 'o', 'ổ': 'o', 'ỗ': 'o', 'ộ': 'o',
		'ơ': 'o', 'ờ': 'o', 'ớ': 'o', 'ở': 'o', 'ỡ': 'o', 'ợ': 'o',
		'ù': 'u', 'ú': 'u', 'ủ': 'u', 'ũ': 'u', 'ụ': 'u',
		'ư': 'u', 'ừ': 'u', 'ứ': 'u', 'ử': 'u', 'ữ': 'u', 'ự': 'u',
		'ỳ': 'y', 'ý': 'y', 'ỷ': 'y', 'ỹ': 'y', 'ỵ': 'y',
		'đ': 'd',
		'À': 'A', 'Á': 'A', 'Ả': 'A', 'Ã': 'A', 'Ạ': 'A',
		'Ă': 'A', 'Ằ': 'A', 'Ắ': 'A', 'Ẳ': 'A', 'Ẵ': 'A', 'Ặ': 'A',
		'Â': 'A', 'Ầ': 'A', 'Ấ': 'A', 'Ẩ': 'A', 'Ẫ': 'A', 'Ậ': 'A',
		'È': 'E', 'É': 'E', 'Ẻ': 'E', 'Ẽ': 'E', 'Ẹ': 'E',
		'Ê': 'E', 'Ề': 'E', 'Ế': 'E', 'Ể': 'E', 'Ễ': 'E', 'Ệ': 'E',
		'Ì': 'I', 'Í': 'I', 'Ỉ': 'I', 'Ĩ': 'I', 'Ị': 'I',
		'Ò': 'O', 'Ó': 'O', 'Ỏ': 'O', 'Õ': 'O', 'Ọ': 'O',
		'Ô': 'O', 'Ồ': 'O', 'Ố': 'O', 'Ổ': 'O', 'Ỗ': 'O', 'Ộ': 'O',
		'Ơ': 'O', 'Ờ': 'O', 'Ớ': 'O', 'Ở': 'O', 'Ỡ': 'O', 'Ợ': 'O',
		'Ù': 'U', 'Ú': 'U', 'Ủ': 'U', 'Ũ': 'U', 'Ụ': 'U',
		'Ư': 'U', 'Ừ': 'U', 'Ứ': 'U', 'Ử': 'U', 'Ữ': 'U', 'Ự': 'U',
		'Ỳ': 'Y', 'Ý': 'Y', 'Ỷ': 'Y', 'Ỹ': 'Y', 'Ỵ': 'Y',
		'Đ': 'D'
	};

	return text.split('').map(char => vietnameseMap[char] || char).join('');
};

/**
 * Generate short name from full name
 * Example: "Nguyễn Văn Tiến" => "NVTien"
 * @param {string} fullName - Full name
 * @returns {string} Short name in ASCII
 */
const generateShortName = (fullName) => {
	if (!fullName || typeof fullName !== 'string') {
		return '';
	}

	const nameParts = fullName.trim().split(/\s+/).filter(part => part.length > 0);

	if (nameParts.length === 0) {
		return '';
	}

	if (nameParts.length === 1) {
		return toAscii(nameParts[0]);
	}

	const initials = nameParts.slice(0, -1).map(part => toAscii(part)[0]).join('');
	const lastName = toAscii(nameParts[nameParts.length - 1]);

	return initials + lastName;
};

/**
 * Get payment settings from database
 * @returns {Promise<Object>} Settings object
 */
const getPaymentSettings = async () => {
	try {
		const settings = await Settings.findOne({ key: SETTINGS_KEY });

		if (!settings) {
			throw new Error('Payment settings not configured');
		}

		return {
			bankNameId: settings.bankNameId,
			bankAccountId: settings.bankAccountId,
			prefixMessage: settings.prefixMessage
		};
	} catch (error) {
		console.error('Error fetching payment settings:', error);
		throw error;
	}
};

/**
 * Format order payment description
 * @param {string} orderId - Order ID
 * @param {string} studentId - Student ID
 * @param {string} fullName - Customer full name
 * @returns {Promise<string>} Formatted payment description
 */
/**
 * Format payment description (shared function for both orders and direct sales)
 * @param {string} orderCode - Order code
 * @param {string} identifier - Student ID for orders, or "TAC {username}" for direct sales
 * @param {string} [shortName] - Short name (optional, for orders only)
 * @returns {Promise<string>} Formatted payment description
 */
const formatPaymentDescription = async (orderCode, identifier, shortName = '') => {
	try {
		const settings = await getPaymentSettings();
		const parts = [settings.prefixMessage, orderCode, identifier];
		if (shortName) {
			parts.push(shortName);
		}
		return parts.join(' ');
	} catch (error) {
		console.error('Error formatting payment description:', error);
		throw error;
	}
};

/**
 * Format order payment description
 * @param {string} orderId - Order ID
 * @param {string} studentId - Student ID
 * @param {string} fullName - Customer full name
 * @returns {Promise<string>} Formatted payment description
 */
const formatOrderPaymentDescription = async (orderId, studentId, fullName) => {
	const shortName = generateShortName(fullName);
	return formatPaymentDescription(orderId, studentId, shortName);
};

/**
 * Generate VietQR payment URL for orders
 * @param {number} amount - Payment amount
 * @param {string} orderId - Order ID
 * @param {string} studentId - Student ID
 * @param {string} fullName - Customer full name
 * @returns {Promise<string>} VietQR URL
 */
const generateOrderPaymentQR = async (amount, orderId, studentId, fullName) => {
	try {
		const settings = await getPaymentSettings();
		const description = await formatOrderPaymentDescription(orderId, studentId, fullName);

		const baseUrl = 'https://img.vietqr.io/image';
		const qrUrl = `${baseUrl}/${settings.bankNameId}-${settings.bankAccountId}-qr_only.png?amount=${amount}&addInfo=${encodeURIComponent(description)}`;

		return qrUrl;
	} catch (error) {
		console.error('Error generating order payment QR:', error);
		throw error;
	}
};

/**
 * Generate payment QR code URL for direct sales
 * @param {number} amount - Payment amount
 * @param {string} orderCode - Order code
 * @param {string} username - Seller username
 * @returns {Promise<string>} QR code URL
 */
const generateDirectSalePaymentQR = async (amount, orderCode, username) => {
	try {
		const settings = await getPaymentSettings();

		// Use shared formatPaymentDescription with TAC identifier
		const description = await formatPaymentDescription(orderCode, `TAC ${username}`);

		const baseUrl = 'https://img.vietqr.io/image';
		const qrUrl = `${baseUrl}/${settings.bankNameId}-${settings.bankAccountId}-qr_only.png?amount=${amount}&addInfo=${encodeURIComponent(description)}`;

		return qrUrl;
	} catch (error) {
		console.error('Error generating direct sale payment QR:', error);
		throw error;
	}
};

module.exports = {
	formatOrderPaymentDescription,
	generateOrderPaymentQR,
	generateDirectSalePaymentQR
};
