/**
 * Product catalogue reads for pricing and the public storefront. A `tx` is the
 * transaction from `withTransaction`. `fields` is the list of field names the
 * caller reads; the stock cache and other internals stay out of what is loaded
 * unless a caller names them.
 */
const Product = require('../../models/Product');
const sellable = require('./sellable');
const { withStringId, toRecord } = require('./records');
const { translating } = require('./errors');
const { safeSearch } = require('../../utils/query-guard');
const { toSkipTake, buildPaginationMeta } = require('@sab/shared');
const { publicCodeBackfill } = require('./public-code-backfill');
const { RecordValidationError } = require('../errors');

const { FALLBACK_PRODUCT_IMAGE: FALLBACK_IMAGE } = require('@sab/shared');

const { assertSaleChannel, sellableQuery, productSellableFilter, SALES_CHANNELS } = sellable;

// The only fields an edit may change. `stockQuantity` is absent on purpose: it
// is a cache of the stock ledger and changes only through a movement.
const EDITABLE_FIELDS = ['name', 'description', 'price', 'category', 'imageUrl', 'available', 'salesChannel', 'minOrderQuantity'];

const CUSTOMER_HIDDEN_SELECTION = '-stockQuantity -sku -isActive';

/** "Contains `search`" over name or description, as a filter. No search, no filter. */
function searchClause(search) {
	const match = safeSearch(search);
	return match ? { $or: [{ name: match }, { description: match }] } : {};
}

/**
 * Sellable products on `channel`, oldest first, as plain records, optionally only the one
 * with this `publicCode` or `id`. Records carry the store's `__v`; other backends will
 * not, so callers must not read it.
 *
 * `channel` is validated before anything is queried and the error is thrown
 * synchronously, so a caller that forgot it fails on the call, not on the await.
 *
 * @param {'online'|'offline'} channel
 * @param {{publicCode?: string, id?: string}} [options] `id` is a canonical record id
 * @returns {Promise<object[]>}
 * @throws {TypeError} channel missing or unknown
 */
function findSellable(channel, { publicCode, id } = {}) {
	const filter = {
		...(publicCode !== undefined && { publicCode }),
		...(id !== undefined && { _id: id })
	};
	return Product.find(productSellableFilter(channel, filter)).sort({ createdAt: 1, _id: 1 }).lean().then((found) => found.map(withStringId));
}

/**
 * Sellable products on `channel`, by category then name, optionally narrowed to
 * one category and to a name/description text. `forCustomers` leaves out the
 * stock level, the SKU and the retired `isActive` flag, which a customer must
 * never receive.
 *
 * @param {'online'|'offline'} channel
 * @param {{category?: string, search?: string, forCustomers?: boolean}} [options]
 * @returns {Promise<object[]>}
 * @throws {TypeError} channel missing or unknown
 */
async function listSellable(channel, { category, search, forCustomers = false } = {}) {
	const filter = { ...(category && { category }), ...searchClause(search) };
	let query = Product.find(productSellableFilter(channel, filter));
	if (forCustomers) query = query.select(CUSTOMER_HIDDEN_SELECTION);
	const found = await query.sort({ category: 1, name: 1 }).lean();
	return found.map(withStringId);
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
	const query = Product.find(productSellableFilter(channel, { _id: { $in: ids } })).select(fields.join(' ')).lean();
	return tx ? query.session(tx) : query;
}

/**
 * The storefronts of the products with these ids. Mongo products have no storefront,
 * so every cart is in the one storefront-less shop.
 *
 * @returns {Promise<[null]>}
 */
async function storefrontIdsOf() {
	return [null];
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

/** Every category in use, unordered. */
function listCategories() {
	return Product.distinct('category');
}

/**
 * The page of products an admin manages, newest first (ties by id, so a page
 * boundary never repeats or drops a row). `salesChannel` filters on the channel
 * the admin set, not on sellability; a row written before the field existed
 * counts as 'all'. Rows carry the schema defaults. A `storefrontId` is ignored: Mongo
 * products have no storefront.
 *
 * @param {{page: number, limit: number, search?: string, category?: string, available?: boolean, salesChannel?: string, storefrontId?: string}} query
 * @returns {Promise<{data: object[], meta: {page: number, limit: number, total: number, totalPages: number}}>} `meta.total` counts every match, not the page
 */
async function listPage({ page, limit, search, category, available, salesChannel }) {
	const channelClause = salesChannel === 'all'
		? { $or: [{ salesChannel: 'all' }, { salesChannel: { $exists: false } }] }
		: { salesChannel };

	// $and keeps the channel clause from colliding with the search $or.
	const text = searchClause(search);
	const clauses = [
		Object.keys(text).length > 0 && text,
		salesChannel && channelClause
	].filter(Boolean);

	const filter = {
		...(clauses.length > 0 && { $and: clauses }),
		...(category && { category }),
		...(available !== undefined && { available })
	};

	// `total` and `data` are read in parallel, not from one snapshot, so a concurrent
	// write can make them disagree by a row. Accepted: the list is advisory.
	const { skip, take } = toSkipTake(page, limit);
	const [rows, total] = await Promise.all([
		Product.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(take),
		Product.countDocuments(filter)
	]);
	return { data: rows.map(toRecord), meta: buildPaginationMeta(total, { page, limit }) };
}

/**
 * How many products there are, how many are available and the cached stock of
 * all of them together.
 *
 * @returns {Promise<{total: number, active: number, totalStock: number}>}
 */
async function summarizeCatalog() {
	const [stats] = await Product.aggregate([
		{
			$group: {
				_id: null,
				totalProducts: { $sum: 1 },
				activeProducts: {
					$sum: { $cond: [{ $eq: ['$available', true] }, 1, 0] }
				},
				totalStock: { $sum: '$stockQuantity' }
			}
		}
	]);
	return { total: stats?.totalProducts || 0, active: stats?.activeProducts || 0, totalStock: stats?.totalStock || 0 };
}

/** The id of every product, unordered. */
async function listIds() {
	const rows = await Product.find({}).select('_id').lean();
	return rows.map((row) => String(row._id));
}

/** Id and category of every product; a product without a category has `category` undefined. */
async function listCategoryById() {
	const rows = await Product.find({}).select('category').lean();
	return rows.map(withStringId);
}

/** True when a product with this id exists. */
async function exists(id) {
	return Boolean(await Product.exists({ _id: id }));
}

/** True when a product with this name exists (exact match). */
async function existsByName(name) {
	return Boolean(await Product.exists({ name }));
}

/** The product with this id, or null. @throws {InvalidIdError} */
function findById(id) {
	return translating(async () => {
		const product = await Product.findById(id);
		return product ? toRecord(product) : null;
	});
}

/**
 * Insert a product whose stock cache starts at `openingStock`. The caller
 * records the matching applied `opening` movement in the same `tx`, so cache and
 * ledger agree from the first moment.
 *
 * @param {object} fields what the request chose, defaults resolved
 * @param {number} openingStock
 * @param {object|null} tx
 * @returns {Promise<object>}
 * @throws {RecordValidationError|DuplicateKeyError}
 */
function create(fields, openingStock, tx) {
	return translating(async () => {
		const { images, ...rest } = fields;
		// This store keeps one image: the gallery's cover.
		const created = new Product({ ...rest, ...(Array.isArray(images) && { imageUrl: images[0] ?? FALLBACK_IMAGE }), stockQuantity: openingStock });
		await created.save(tx ? { session: tx } : undefined);
		return toRecord(created);
	});
}

/**
 * Apply `changes` (only the editable fields are taken) and return the product
 * as stored afterwards, or null when it does not exist.
 *
 * @param {string} id
 * @param {object} changes
 * @returns {Promise<object|null>}
 * @throws {RecordValidationError|DuplicateKeyError|InvalidIdError}
 */
function update(id, changes, tx) {
	const picked = Object.fromEntries(EDITABLE_FIELDS.filter((field) => changes[field] !== undefined).map((field) => [field, changes[field]]));
	// This store keeps one image: the gallery's cover.
	if (Array.isArray(changes.images)) picked.imageUrl = changes.images[0] ?? FALLBACK_IMAGE;
	return translating(async () => {
		const product = await Product.findByIdAndUpdate(id, picked, { new: true, runValidators: true, ...(tx && { session: tx }) });
		return product ? toRecord(product) : null;
	});
}

// This store has no variants: a product is its own stock, so there is nothing to lock.
async function lockVariants() {}

/**
 * This store has no variants. A setup without options (one default variant) is
 * accepted and changes nothing; options are refused.
 *
 * @throws {RecordValidationError}
 */
async function saveVariantSetup(_productId, setup) {
	if (setup.options.length > 0) {
		throw new RecordValidationError([{ field: 'options', message: 'Kho dữ liệu hiện tại không hỗ trợ phân loại sản phẩm' }]);
	}
	return { openings: [], archived: 0, deleted: 0 };
}

/** Whether an uploaded image is still a product's cover. */
async function isImageInUse(url) {
	return Boolean(await Product.exists({ imageUrl: url }));
}

/** Delete the product with this id; false when there was none. @throws {InvalidIdError} */
function remove(id) {
	return translating(async () => Boolean(await Product.findByIdAndDelete(id)));
}

module.exports = {
	SALES_CHANNELS,
	assertSaleChannel,
	findSellable,
	listSellable,
	listCategories,
	listIds,
	listCategoryById,
	...publicCodeBackfill(Product),
	listPage,
	summarizeCatalog,
	exists,
	existsByName,
	findById,
	create,
	update,
	remove,
	findSellableForPricing,
	lockVariants,
	saveVariantSetup,
	isImageInUse,
	storefrontIdsOf,
	findAvailableNames,
	listSellableInCategories
};
