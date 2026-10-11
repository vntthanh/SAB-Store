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
 *   ids); callers that serialise them are not on the repository yet.
 */
const BACKENDS = {
	mongo: () => ({
		stockLedger: require('./mongo/stock-ledger'),
		orders: require('./mongo/orders'),
		withTransaction: require('./mongo/tx').withTransaction
	})
};

const name = process.env.DATA_BACKEND || 'mongo';
if (!Object.hasOwn(BACKENDS, name)) {
	throw new Error(`Unknown DATA_BACKEND "${name}"; expected one of: ${Object.keys(BACKENDS).join(', ')}`);
}

module.exports = BACKENDS[name]();
