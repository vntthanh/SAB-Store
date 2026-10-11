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
 * - `translateWriteError(err)` turns this store's own write error into the domain
 *   error above, or returns it unchanged. Only code not yet behind a repository needs it.
 * - Lean records carry the store's `__v`; other backends will not. Callers must
 *   not read it.
 * - `combos.findSellable` keeps nested `categoryRequirements[]._id` as native ids.
 * - Errors: a repository write raises `DuplicateKeyError` (unique constraint),
 *   `RecordValidationError` (schema rule) or `InvalidIdError` (value of the wrong
 *   type, with `path` and `value`) from data/errors.js. Repositories not yet
 *   converted (orders, the merge import) still let the engine's own error through.
 * - A repository that pages returns `{ data, meta: { page, limit, total, totalPages } }`:
 *   the page's rows and the count of every match, for a page and limit the
 *   caller already clamped. `totalPages` is 0 for an empty result.
 *   Rows sort by their key and then by id, so a page boundary never repeats or
 *   drops a row.
 * - Computed fields: `combos.listSellable`, `combos.findById`, `combos.create` and
 *   `combos.update` return records that include the `totalRequiredQuantity`
 *   virtual (sum of the requirement quantities) and `id`; `products.findById`,
 *   `create`, `update` and `listPage` include `inStock` (`stockQuantity > 0`).
 *   Another backend must compute them. Lean list reads carry none.
 * - Single-record reads that feed a response (`findById`, `create`, `update`)
 *   return complete records with the schema defaults applied; list reads return
 *   the stored fields only.
 * - `settings.findStorefront` returns stored values only: missing or NULL means "not
 *   set" and the caller applies the code default; `''` means deliberately hidden.
 *   `findConfig` and `upsertConfig` return the row with the code defaults applied, only
 *   for missing/NULL fields and never for `''`. Another backend substitutes defaults
 *   with a null check, never `||`. Partial `upsertConfig` and the layer that enforces
 *   length/trim rules: see data/mongo/settings.js.
 * - `dataSnapshot` moves whole rows in the wire form of data/snapshot.js (ids as
 *   hex strings, dates as ISO strings, `__v` kept), unlike the other repositories.
 */
const BACKENDS = {
	mongo: () => ({
		stockLedger: require('./mongo/stock-ledger'),
		orders: require('./mongo/orders'),
		products: require('./mongo/products'),
		combos: require('./mongo/combos'),
		settings: require('./mongo/settings'),
		dataSnapshot: require('./mongo/data-snapshot'),
		withTransaction: require('./mongo/tx').withTransaction,
		translateWriteError: require('./mongo/errors').translateWriteError
	})
};

const name = process.env.DATA_BACKEND || 'mongo';
if (!Object.hasOwn(BACKENDS, name)) {
	throw new Error(`Unknown DATA_BACKEND "${name}"; expected one of: ${Object.keys(BACKENDS).join(', ')}`);
}

module.exports = BACKENDS[name]();
