/**
 * The store's repositories, on PostgreSQL through Prisma, and its transactions.
 * Ids are UUID strings.
 *
 * Record shape contract for repository functions:
 * - Records are plain objects, never Prisma rows or query objects. The id is
 *   `_id`, a lowercase uuid string, which is also the public id in the API.
 * - `tx` is opaque: obtain it from `withTransaction` and pass it back unchanged.
 * - A legacy 24-hex id (carts, links, jobs and backups made before the move from
 *   MongoDB) is accepted wherever an id is, and mapped to its uuid
 *   (`normalizeRecordId`, data/ids.js).
 * - `translateWriteError(err)` turns a Prisma write error into the domain error
 *   below, or returns it unchanged. Only code not yet behind a repository needs it.
 * - Errors: a repository write raises `DuplicateKeyError` (unique constraint),
 *   `RecordValidationError` (schema rule) or `InvalidIdError` (value of the wrong
 *   type, with `path` and `value`) from data/errors.js. A retry loop on a unique
 *   column asks `isDuplicateKeyOn(err, 'column')`, never `err.code`.
 * - A repository that pages returns `{ data, meta: { page, limit, total, totalPages } }`:
 *   the page's rows and the count of every match, for a page and limit the
 *   caller already clamped. `totalPages` is 0 for an empty result.
 *   Rows sort by their key and then by id, so a page boundary never repeats or
 *   drops a row.
 * - Computed fields: none (`inStock`, `currentPrice` and the like are not on any
 *   record), apart from a variant's `label` and `effectivePrice` below.
 * - Absent optional fields: an optional field that was never set (a product's
 *   description, sku, weight, dimensions, salePrice, sale dates; a combo's
 *   description) is an absent key, not `null`. `maxOrderQuantity` is `null`.
 * - `products.findSellable` returns oldest first (`createdAt`, then id).
 * - Single-record reads that feed a response (`findById`, `create`, `update`)
 *   return complete records with the schema defaults applied.
 * - Orders: nested arrays come from child tables in `position` order, an optional
 *   column that is NULL is an absent key and `comboInfo` is `null` when the order
 *   has no combo. `orders.findById(id, tx)` also takes the order's row lock, so a
 *   status change that read the order inside `tx` writes against the status it
 *   read (see data/postgres/orders.js). `withProducts: [fields]` turns each
 *   `items[].productId` into `{ _id, ...fields }`, or `null` for a product that no
 *   longer exists. `orders.listPage` takes one `sort` entry and appends the id as
 *   tie-break. `complete: true` applies schema defaults to stored fields
 *   (`findDetail`, `listPage`); `findByCode`, `create`, `updateNotes`,
 *   `applyStatusChange` and `replaceItems` always do.
 * - `settings.findStorefront` returns stored values only: missing or NULL means "not
 *   set" and the caller applies the code default; `''` means deliberately hidden.
 *   `findConfig` and `upsertConfig` return the row with the code defaults applied, only
 *   for missing/NULL fields and never for `''`. Partial `upsertConfig` and the layer
 *   that enforces length/trim rules: see data/postgres/settings.js.
 * - Variants and images: a product record carries `images` (gallery order,
 *   `imageUrl` is its cover), `options` (`[{name, values}]`) and `variants`
 *   (`[{_id, optionValues, label?, price?, effectivePrice, sku?, imageUrl?, isActive,
 *   archivedAt?, stockQuantity}]`; customer reads list active variants without stock or
 *   SKU). Every product has at least one variant; one without options has a single
 *   default variant with no option values. `findSellableForPricing` loads variants
 *   only when `variants` is among the fields. A stock movement and an order line carry
 *   `variantId`; a movement recorded without one belongs to the product's default
 *   variant. `products.saveVariantSetup` writes options and variants (see
 *   data/postgres/product-variants.js).
 * - Storefronts: a product record carries `storefrontId`, a combo record
 *   `storefrontIds` (sorted; a combo is offered in one or more storefronts) and an order
 *   record `storefrontId` only when set (absent for a direct sale). `products.create`
 *   defaults `storefrontId`, and `combos.create` defaults `storefrontIds`, to the default
 *   storefront of data/default-storefront.js when the caller names none. `bootstrap.hasStorefront`
 *   tells the seed whether the migration's default storefront is there.
 * - `storefronts` (access and display) and `emailLists`: records with a `_id` uuid, an unset
 *   description absent. `products.listSellable`, `products.findSellable`,
 *   `products.findSellableForPricing(channel, ids, fields, tx, {storefrontId})`, `combos.listSellable(channel,
 *   {storefrontId})`, `combos.findSellable` and `combos.findSellableForPricing(channel, fields, tx, {storefrontId})`
 *   take an optional `storefrontId`. `combos.update` replaces the
 *   link set when given `storefrontIds` and refuses an empty one. `storefronts.viewerCanAccess(id, email)`
 *   and `accessibleIds(email)` only evaluate the access rules (a PUBLIC storefront has none; the
 *   caller decides what that means) and fold the address to lowercase themselves.
 *   `storefronts.remove` and a deactivation raise `ConflictError` (data/errors.js) with code
 *   STOREFRONT_IN_USE or LAST_ACTIVE_STOREFRONT, and any other foreign-key failure on a write is a
 *   `ConflictError` REFERENCE_VIOLATION. A duplicate rule is `DuplicateKeyError` on `value`
 *   (EMAIL, DOMAIN) or `emailListId` (LIST).
 * - `mailSettings.findConfig` returns the SMTP row (password as its encrypted envelope) or
 *   null; `upsertConfig` applies the given fields.
 * - `dashboard.stats` returns the dashboard's figures; `topSelling[].productId` is a
 *   string. `topSelling` ranks every order line whatever the order's status, grouped
 *   by (productId, productName): one product sold under two names gives two rows.
 * - `orders.listAll` is the one unpaged list (the Excel export) and returns stored
 *   fields only. It sorts by `createdAt` and then id; `topSelling` by quantity, then
 *   product id and name, so ties come back in the same order on every read.
 * - Also exported for the admin routes: `orders.STATUS_VALUES` (the status enum),
 *   `orders.existsByCode`, `products.SALES_CHANNELS`, `products.existsByName`,
 *   `combos.exists`, `combos.listNames`, and `dataSnapshot.countRows` (row counts
 *   including the login tables, never their rows).
 * - Used by `scripts/audit-combo-pricing.js`: `orders.listWithCombo`,
 *   `orders.count` and `products.listCategoryById`.
 * - `bootstrap` serves the first-run seed (`databaseName`, `hasLoginUsers`,
 *   `hasAdmin`) and reads the auth library's login table directly; `databaseName`
 *   is async (it asks the server).
 * - `dataSnapshot` moves whole rows in the wire form of data/snapshot.js (ids as
 *   strings, dates as ISO strings), unlike the other repositories. A restore maps
 *   every id of the file, legacy hex ones included, to a uuid, in row ids,
 *   references, JSON and idempotency keys.
 * - A restore reserves a block of the `stock_movements` `seq` sequence (under a
 *   table lock) instead of resetting it to the maximum, so a rolled-back restore
 *   leaves a gap, never a collision; order rows are locked with `FOR NO KEY UPDATE`,
 *   not `FOR UPDATE`, so child-row inserts (which take a key share lock) do not
 *   queue behind a status change.
 */
module.exports = {
	stockLedger: require('./postgres/stock-ledger'),
	orders: require('./postgres/orders'),
	products: require('./postgres/products'),
	combos: require('./postgres/combos'),
	storefronts: require('./postgres/storefronts'),
	emailLists: require('./postgres/email-lists'),
	settings: require('./postgres/settings'),
	mailSettings: require('./postgres/mail-settings'),
	dataSnapshot: require('./postgres/data-snapshot'),
	dashboard: require('./postgres/dashboard'),
	bootstrap: require('./postgres/bootstrap'),
	withTransaction: require('./postgres/tx').withTransaction,
	translateWriteError: require('./postgres/errors').translateWriteError
};
