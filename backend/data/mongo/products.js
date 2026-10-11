/**
 * Product catalogue reads for pricing and the public storefront. A `tx` is the
 * transaction from `withTransaction`. `fields` is the list of field names the
 * caller reads; the stock cache and other internals stay out of what is loaded
 * unless a caller names them.
 */
const Product = require('../../models/Product');
const sellable = require('./sellable');
const { withStringId } = require('./records');

const { assertSaleChannel, sellableQuery } = sellable;

/**
 * Sellable products on `channel`, as plain records, optionally only the one
 * with this `publicCode`. Records carry the store's `__v`; other backends will
 * not, so callers must not read it.
 *
 * `channel` is validated before anything is queried and the error is thrown
 * synchronously, so a caller that forgot it fails on the call, not on the await.
 *
 * @param {'online'|'offline'} channel
 * @param {{publicCode?: string}} [options]
 * @returns {Promise<object[]>}
 * @throws {TypeError} channel missing or unknown
 */
function findSellable(channel, { publicCode } = {}) {
	const filter = publicCode === undefined ? {} : { publicCode };
	return Product.findSellable(channel, filter).lean().then((found) => found.map(withStringId));
}

/**
 * The sellable products with these ids, for pricing. Unlike other repository
 * reads the records keep the store's own `_id`: pricing writes it into the
 * order lines, and its callers store those lines without casting.
 *
 * @param {'online'|'offline'} channel
 * @param {string[]} ids canonical record ids
 * @param {string[]} fields
 * @param {object|null} [tx]
 * @returns {Promise<object[]>}
 */
async function findSellableForPricing(channel, ids, fields, tx) {
	const query = Product.findSellable(channel, { _id: { $in: ids } }).select(fields.join(' ')).lean();
	return tx ? query.session(tx) : query;
}

/**
 * Names of the products with these ids that are switched on, whatever channel
 * they sell on.
 *
 * @param {string[]} ids
 * @param {object|null} [tx]
 * @returns {Promise<string[]>}
 */
async function findAvailableNames(ids, tx) {
	const query = Product.find({ _id: { $in: ids }, available: true }).select('name').lean();
	const products = await (tx ? query.session(tx) : query);
	return products.map((product) => product.name);
}

/**
 * Sellable products in any of `categories`, by name.
 *
 * @param {'online'|'offline'} channel
 * @param {string[]} categories
 * @param {string[]} fields
 * @returns {Promise<object[]>}
 */
async function listSellableInCategories(channel, categories, fields) {
	const products = await Product.find({ category: { $in: categories }, ...sellableQuery(channel) })
		.select(fields.join(' '))
		.sort({ name: 1 })
		.lean();
	return products.map(withStringId);
}

module.exports = {
	assertSaleChannel,
	findSellable,
	findSellableForPricing,
	findAvailableNames,
	listSellableInCategories
};
