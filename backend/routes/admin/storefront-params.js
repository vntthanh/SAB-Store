const { productStorefrontId } = require('@sab/shared');
const { ERROR_CODES, ERROR_MESSAGES, ERROR_CODE_TO_HTTP_STATUS } = require('../../constants/errorCodes');

/**
 * The `?storefrontId=` of an admin list. Absent or empty means "no filter";
 * anything else must be a record id, because a junk value silently dropped would
 * show every storefront's rows under a filter the admin believes is applied.
 *
 * @param {unknown} raw
 * @returns {{value?: string, invalid?: true}}
 */
function readStorefrontFilter(raw) {
	if (raw === undefined || raw === '') return {};
	const parsed = productStorefrontId.safeParse(raw);
	return parsed.success ? { value: parsed.data } : { invalid: true };
}

/** Body of every error the admin storefront routes answer: `{ success, code, message }`. */
function sendCoded(res, code, message = ERROR_MESSAGES[code].vi) {
	return res.status(ERROR_CODE_TO_HTTP_STATUS[code]).json({ success: false, code, message });
}

/** A malformed filter is a bad request; only a well-formed id that names nothing is STOREFRONT_NOT_FOUND. */
const invalidStorefrontFilter = (res) =>
	res.status(400).json({ success: false, code: ERROR_CODES.VALIDATION_ERROR, message: 'Gian hàng không hợp lệ' });

module.exports = { readStorefrontFilter, invalidStorefrontFilter, sendCoded };
