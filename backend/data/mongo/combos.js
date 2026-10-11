/**
 * Combo reads for pricing and the public storefront. A `tx` is the transaction
 * from `withTransaction`.
 */
const Combo = require('../../models/Combo');
const { withStringId } = require('./records');

/**
 * Combos that may discount an order on `channel`, offered order first
 * (priority, then newest), as plain records, optionally only the one with this
 * `publicCode`. Nested `categoryRequirements[]._id` stay the store's native ids
 * and records carry `__v`; callers must not read either. Validates `channel`
 * synchronously, like `products.findSellable`.
 *
 * @param {'online'|'offline'} channel
 * @param {{publicCode?: string}} [options]
 * @returns {Promise<object[]>}
 * @throws {TypeError} channel missing or unknown
 */
function findSellable(channel, { publicCode } = {}) {
	const filter = publicCode === undefined ? {} : { publicCode };
	return Combo.findSellable(channel, filter).lean().then((found) => found.map(withStringId));
}

/**
 * The combos pricing may apply on `channel`, in offered order. Records keep the
 * store's own `_id`: pricing copies it into the order's combo lines.
 *
 * @param {'online'|'offline'} channel
 * @param {string[]} fields
 * @param {object|null} [tx]
 * @returns {Promise<object[]>}
 */
async function findSellableForPricing(channel, fields, tx) {
	const query = Combo.findSellable(channel).select(fields.join(' ')).lean();
	return tx ? query.session(tx) : query;
}

module.exports = { findSellable, findSellableForPricing };
