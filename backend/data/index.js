/**
 * The active data implementation. `DATA_BACKEND` picks it, transactions
 * included; an unknown value stops the process at require time rather than
 * falling back to another store.
 *
 * Record shape contract for repository functions:
 * - Records are plain objects, never store documents or query objects. The id is
 *   `_id`, a string, which is also the public id in the API.
 * - `tx` is opaque: obtain it from `withTransaction` and pass it back unchanged.
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
 *   type, with `path` and `value`) from data/errors.js. A retry loop on a unique
 *   column asks `isDuplicateKeyOn(err, 'column')`, never `err.code`.
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
 * - Orders: records keep the store's native ids nested in `items[]` (`_id`,
 *   `productId`, `comboId`), `statusHistory[]` and `createdBy`; only the record's
 *   own `_id` and an attached product's `_id` are strings. `withProducts: [fields]`
 *   turns each `items[].productId` into `{ _id, ...fields }`, or `null` for a
 *   product that no longer exists. `orders.listPage` takes one `sort` entry and
 *   appends the id as tie-break. `complete: true` applies schema defaults to
 *   stored fields (`findDetail`, `listPage`); `findByCode`, `create`,
 *   `updateNotes`, `applyStatusChange` and `replaceItems` always do.
 * - `settings.findStorefront` returns stored values only: missing or NULL means "not
 *   set" and the caller applies the code default; `''` means deliberately hidden.
 *   `findConfig` and `upsertConfig` return the row with the code defaults applied, only
 *   for missing/NULL fields and never for `''`. Another backend substitutes defaults
 *   with a null check, never `||`. Partial `upsertConfig` and the layer that enforces
 *   length/trim rules: see data/mongo/settings.js.
 * - `dashboard.stats` returns the dashboard's figures; `topSelling[].productId` is a
 *   string. `topSelling` ranks every order line whatever the order's status, grouped
 *   by (productId, productName): one product sold under two names gives two rows,
 *   and another backend must group the same way. Today `byCategory`, `byChannel`
 *   and availability are tallied in code over all products; a database backend must
 *   compute them in the database (`groupBy`), since aggregates belong there.
 * - `orders.listAll` is the one unpaged list (the Excel export) and returns stored
 *   fields only. It sorts by `createdAt` alone and `topSelling` by quantity alone, so
 *   ties come back in no defined order; both gain an id tie-break when the store flips.
 * - Also exported for the admin routes: `orders.STATUS_VALUES` (the status enum),
 *   `orders.existsByCode`, `products.SALES_CHANNELS`, `products.existsByName`,
 *   `combos.exists`, `combos.listNames`, and `dataSnapshot.countRows` (row counts
 *   including the login tables, never their rows).
 * - One-off tooling: `orders.listWithCombo`, `orders.countMissingStockDeducted`,
 *   `orders.backfillStockDeducted`, `products.listIds`, `products.listCategoryById`,
 *   `stockLedger.readOpeningBasis` and the public-code backfill set on `products`
 *   and `combos` (`count`, `listWithoutPublicCode`, `assignMissingPublicCode`,
 *   `ensureIndexes`). The stock-deducted pair exists only for a store where the
 *   field can be absent; a NOT NULL column makes it a no-op. `bootstrap` serves
 *   the first-run seed (`databaseName`, `hasLoginUsers`, `loginUserExists`) and reads
 *   the auth library's login table directly; it moves with auth.
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
		dashboard: require('./mongo/dashboard'),
		bootstrap: require('./mongo/bootstrap'),
		withTransaction: require('./mongo/tx').withTransaction,
		translateWriteError: require('./mongo/errors').translateWriteError
	})
};

const name = process.env.DATA_BACKEND || 'mongo';
if (!Object.hasOwn(BACKENDS, name)) {
	throw new Error(`Unknown DATA_BACKEND "${name}"; expected one of: ${Object.keys(BACKENDS).join(', ')}`);
}

module.exports = BACKENDS[name]();
