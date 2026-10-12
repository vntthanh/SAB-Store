/**
 * The active data implementation. `DATA_BACKEND` picks it (`postgres`, the default,
 * or `mongo`, the rollback store), transactions included; an unknown value stops the process at
 * require time rather than falling back to another store. On `postgres`, ids are
 * UUID strings.
 *
 * Record shape contract for repository functions:
 * - Records are plain objects, never store documents or query objects. The id is
 *   `_id`, a string, which is also the public id in the API.
 * - `tx` is opaque: obtain it from `withTransaction` and pass it back unchanged.
 * - Exceptions, keeping the store's native `_id`: `products.findSellableForPricing`
 *   and `combos.findSellableForPricing`. This store returns its id object
 *   (ObjectId); postgres returns the id as a lowercase uuid string. Pricing copies
 *   those ids into order lines, and its callers only `String()` them or compare
 *   the normalised form (`normalizeRecordId` maps a legacy hex id to its uuid).
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
 * - Computed fields: none. The Mongoose virtuals (`inStock`, `totalRequiredQuantity`,
 *   `currentPrice`, `onSale`, `id`) are not serialised by `toJSON`, so no record
 *   carries them (measured) and no consumer reads them; a backend must not add them.
 * - Absent optional fields: an optional field that was never set (a product's
 *   description, sku, weight, dimensions, salePrice, sale dates; a combo's
 *   description) is an absent key, not `null`. `maxOrderQuantity` is `null`.
 * - `products.findSellable` returns oldest first (`createdAt`, then id).
 * - Single-record reads that feed a response (`findById`, `create`, `update`)
 *   return complete records with the schema defaults applied; list reads return
 *   the stored fields only.
 * - Orders: on mongo, records keep the store's native ids nested in `items[]` (`_id`,
 *   `productId`, `comboId`), `statusHistory[]` and `createdBy`; only the record's
 *   own `_id` and an attached product's `_id` are strings. On postgres every id is
 *   a uuid string, nested arrays come from child tables in `position` order, an
 *   optional column that is NULL is an absent key and `comboInfo` is `null` when
 *   the order has no combo. `orders.findById(id, tx)` on postgres also takes the
 *   order's row lock, so a status change that read the order inside `tx` writes
 *   against the status it read (see data/postgres/orders.js). `withProducts: [fields]`
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
 *   and another backend must group the same way. Mongo tallies `byCategory`,
 *   `byChannel` and availability in code over all products; postgres computes them
 *   in the database (`groupBy`), as aggregates belong there.
 * - `orders.listAll` is the one unpaged list (the Excel export) and returns stored
 *   fields only. It sorts by `createdAt` and then id; `topSelling` by quantity, then
 *   product id and name, so ties come back in the same order on every read.
 * - Also exported for the admin routes: `orders.STATUS_VALUES` (the status enum),
 *   `orders.existsByCode`, `products.SALES_CHANNELS`, `products.existsByName`,
 *   `combos.exists`, `combos.listNames`, and `dataSnapshot.countRows` (row counts
 *   including the login tables, never their rows).
 * - Used by `scripts/audit-combo-pricing.js`: `orders.listWithCombo`,
 *   `orders.count` and `products.listCategoryById`.
 * - Repair functions for rows a legacy store can hold and Postgres cannot, kept with
 *   the same shape on both backends and exercised by the contract tests only:
 *   `orders.countMissingStockDeducted` and `orders.backfillStockDeducted` (the field
 *   can be absent on Mongo; a NOT NULL column makes them a no-op), `products.listIds`,
 *   `stockLedger.readOpeningBasis`, and on `products`
 *   and `combos` `count`, `listWithoutPublicCode`, `assignMissingPublicCode` and
 *   `ensureIndexes`. `bootstrap` serves the first-run seed (`databaseName`,
 *   `hasLoginUsers`, `hasAdmin`) and reads the auth library's login table
 *   directly. `databaseName` may be async (postgres asks the server), so callers
 *   `await` it.
 * - `dataSnapshot` moves whole rows in the wire form of data/snapshot.js (ids as
 *   strings, dates as ISO strings; mongo keeps `__v`, postgres has none), unlike the
 *   other repositories. On postgres a restore maps every id of the file, legacy hex
 *   ones included, to a uuid, in row ids, references, JSON and idempotency keys.
 *   The reverse does not hold: an export from postgres (uuid ids) cannot be restored
 *   onto the mongo backend, whose `ids.js` accepts only 24-hex ids.
 * - Documented postgres differences: a restore reserves a block of the `stock_movements`
 *   `seq` sequence (under a table lock) instead of resetting it to the maximum, so a
 *   rolled-back restore leaves a gap, never a collision; order rows are locked with
 *   `FOR NO KEY UPDATE`, not `FOR UPDATE`, so child-row inserts (which take a key
 *   share lock) do not queue behind a status change.
 */
const { backendName } = require('./backend-name');

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
	}),
	postgres: () => ({
		stockLedger: require('./postgres/stock-ledger'),
		orders: require('./postgres/orders'),
		products: require('./postgres/products'),
		combos: require('./postgres/combos'),
		settings: require('./postgres/settings'),
		dataSnapshot: require('./postgres/data-snapshot'),
		dashboard: require('./postgres/dashboard'),
		bootstrap: require('./postgres/bootstrap'),
		withTransaction: require('./postgres/tx').withTransaction,
		translateWriteError: require('./postgres/errors').translateWriteError
	})
};

module.exports = BACKENDS[backendName]();
