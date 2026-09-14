const axios = require('axios');
const ErrorLogger = require('./errorLogger');

const APPSCRIPT_URL = process.env.APPSCRIPT_URL;
// Every caller fires this without awaiting it (see routes/orders.js,
// routes/seller.js, routes/admin/orders.js), so retry latency here never
// delays an HTTP response — it only decides how long a socket to Google's
// endpoint stays open before giving up.
const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gửi dữ liệu đơn hàng lên Google Forms qua App Script
 * @param {Object} orderData - Thông tin đơn hàng
 * @returns {Promise}
 */
async function sendOrderToAppScript(orderData) {
	if (!APPSCRIPT_URL) throw new Error('APPSCRIPT_URL chưa được cấu hình trong biến môi trường');

	let lastError;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			return await axios.post(APPSCRIPT_URL, orderData, { timeout: REQUEST_TIMEOUT_MS });
		} catch (error) {
			lastError = error;
			if (attempt < MAX_ATTEMPTS) {
				await wait(BASE_BACKOFF_MS * 2 ** (attempt - 1));
			}
		}
	}

	// Every attempt failed: the order never reached AppScript and, without a
	// dead-letter of some kind, would otherwise be lost silently. logCritical
	// at least puts it somewhere ops can find and replay manually.
	ErrorLogger.logCritical('AppScript delivery failed after retries', lastError, {
		orderCode: orderData?.orderCode,
		attempts: MAX_ATTEMPTS
	});
	throw lastError;
}

module.exports = { sendOrderToAppScript };
