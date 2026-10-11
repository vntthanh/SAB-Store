/**
 * The active data implementation. `DATA_BACKEND` picks it, transactions
 * included; an unknown value stops the process at require time rather than
 * falling back to another store.
 *
 * Record shape contract for repository functions:
 * - Records are plain objects, never store documents or query objects. The id is
 *   `_id`, a string, which is also the public id in the API.
 * - `tx` is opaque: obtain it from `withTransaction` and pass it back unchanged.
 * - Exceptions, still returning hydrated documents: `orders.applyStatusChange`
 *   and `orders.replaceItems`. Their callers serialise the result, and a
 *   document's JSON differs from a plain object's (virtuals, `__v`, subdocument
 *   ids); they are serialised by routes that still read the store directly.
 * - Exceptions, keeping the store's native `_id`: `products.findSellableForPricing`
 *   and `combos.findSellableForPricing`. This store returns its id object
 *   (ObjectId); another backend returns the id as a lowercase 24-hex string.
 *   Pricing copies those ids into order lines, and its callers only `String()`
 *   them or compare the normalised form.
 * - Lean records carry the store's `__v`; other backends will not. Callers must
 *   not read it.
 * - `combos.findSellable` keeps nested `categoryRequirements[]._id` as native ids.
 */
const BACKENDS = {
	mongo: () => ({
		stockLedger: require('./mongo/stock-ledger'),
		orders: require('./mongo/orders'),
		products: require('./mongo/products'),
		combos: require('./mongo/combos'),
		withTransaction: require('./mongo/tx').withTransaction
	})
};

const name = process.env.DATA_BACKEND || 'mongo';
if (!Object.hasOwn(BACKENDS, name)) {
	throw new Error(`Unknown DATA_BACKEND "${name}"; expected one of: ${Object.keys(BACKENDS).join(', ')}`);
}

module.exports = BACKENDS[name]();
