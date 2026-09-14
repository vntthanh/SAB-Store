/**
 * Server-side order pricing.
 *
 * Every monetary figure an order is stored with must come from this module.
 * Prices, totals and combo savings sent by a client are advisory at best and
 * hostile at worst, so they are read from the database instead of trusted.
 *
 * Phase 00 ships the contract only. Phase 05 supplies the implementation;
 * Phase 06 calls it from inside the stock flow. The stub throws rather than
 * returning a plausible-looking zero so that a consumer wired up before the
 * implementation lands fails loudly instead of silently writing free orders.
 */

/**
 * Error thrown for every rejected pricing request.
 *
 * Always maps to HTTP 400: each code describes a cart the caller could have
 * validated before sending, never a server fault.
 */
class PricingError extends Error {
	/**
	 * @param {'EMPTY_CART'|'PRODUCT_UNAVAILABLE'|'INVALID_QUANTITY'} code
	 * @param {{missingIds?: string[], productId?: string}} [details]
	 */
	constructor(code, details = {}) {
		super(code);
		this.name = 'PricingError';
		this.code = code;
		this.httpStatus = 400;
		this.details = details;
	}
}

/**
 * Compute an order's totals from the database, ignoring any client-supplied price.
 *
 * Availability is a single rule: a product counts only when `isActive` AND
 * `available` are both true, matching `Product.findAvailable()`. There is
 * deliberately no flag to relax it — an earlier draft of this contract offered
 * one and would have let direct sales sell `available: false` stock.
 *
 * Duplicate `productId` lines are merged rather than rejected, because a cart
 * legitimately reaches this point with the same product added twice.
 *
 * @param {Array<{productId: string, quantity: number}>} items
 *        Cart lines. Lines sharing a productId are summed.
 * @param {object} [opts]
 * @param {import('mongoose').ClientSession|null} [opts.session=null]
 *        Pass when called inside a transaction; every query issued here must
 *        then run with `.session(session)`. Null is a supported mode, not a
 *        degraded one — the deployment has no replica set (see plan AD-4).
 * @returns {Promise<{
 *   totalAmount: number,
 *   orderItems: Array<{
 *     productId: import('mongoose').Types.ObjectId,
 *     productName: string,
 *     price: number,
 *     quantity: number,
 *     fromCombo: boolean,
 *     comboId: import('mongoose').Types.ObjectId|null,
 *     comboName: string|null
 *   }>,
 *   comboInfo: {
 *     comboId: import('mongoose').Types.ObjectId,
 *     comboName: string,
 *     savings: number,
 *     originalTotal: number,
 *     finalTotal: number
 *   }|null,
 *   products: Map<string, import('mongoose').Document>
 * }>}
 *        `orderItems[].productId` is an ObjectId, not a string, so the result
 *        can be written to an Order without re-casting.
 *        `products` is keyed by `productId.toString()` so callers can reuse the
 *        already-loaded documents instead of querying again.
 * @throws {PricingError} An empty cart throws EMPTY_CART; it never returns a
 *        zero total, which would otherwise be indistinguishable from a free order.
 */
async function computeOrderPricing(items, opts = {}) {
	throw new Error('NOT_IMPLEMENTED');
}

module.exports = { computeOrderPricing, PricingError };
