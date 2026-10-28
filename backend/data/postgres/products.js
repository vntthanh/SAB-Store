/**
 * Product catalogue on Postgres: the same functions, arguments and plain records
 * as data/mongo/products.js.
 *
 * Differences a caller can see, all deliberate:
 * - A record has no `__v`, and an optional field that is NULL (description, sku,
 *   weight, dimensions, salePrice, the sale dates) is absent, as it is on a
 *   Mongo document that never set it. `maxOrderQuantity` stays `null`, as there.
 * - There is no "row without salesChannel": the column is NOT NULL, default 'all',
 *   so the channel rule is a plain `IN ('all', channel)`.
 * - `findSellable` returns oldest first and every list orders by its key and then
 *   by id, so a tie never reorders between two reads.
 * - `findSellableForPricing` returns `_id` as a lowercase uuid string.
 * - A record carries `storefrontId` (every product belongs to one storefront).
 *   `create` defaults it to the default storefront when the caller names none, and
 *   an edit may move the product to another one. `findSellable`, `listSellable` and
 *   `findSellableForPricing` take an optional `storefrontId` to list one storefront's products.
 *
 * - A record carries `images` (gallery order; `imageUrl` is the cover, always
 *   `images[0]` or the fallback), `options` (`[{name, values}]`, in position order)
 *   and `variants` (see `variantRecord`). Every product has at least one variant: a
 *   product without options has one default variant with no option values.
 *   Customer reads list only active variants and never their stock or SKU.
 *
 * `stock_quantity` (product and variant) is written by `create` alone (the opening balance, which the
 * caller records as an applied `opening` movement in the same transaction) and
 * otherwise only by the stock ledger.
 */
const { prisma } = require('../../lib/prisma');
const { DEFAULT_STOREFRONT_ID } = require('../default-storefront');
const { toSkipTake, buildPaginationMeta } = require('@sab/shared');
const { SALES_CHANNELS, assertSaleChannel } = require('../sale-channels');
const { PUBLIC_CODE_PATTERN } = require('../../utils/public-code');
const { asString } = require('../../utils/query-guard');
const { translating } = require('./errors');
const { containsInsensitive } = require('./like');
const { drawCodeAndSlug, slugFor, publicCodeBackfill } = require('./public-code');
const { Problems, checkText, checkNumber, checkBoolean, checkEnum, checkDate, recordId } = require('./rules');

// The only fields an edit may change. The stock cache is absent on purpose: it
// changes only through a movement.
const EDITABLE_FIELDS = ['name', 'description', 'price', 'category', 'imageUrl', 'available', 'salesChannel', 'minOrderQuantity', 'storefrontId'];

const SEARCH_MAX_LENGTH = 100;
const DIMENSION_COLUMNS = { length: 'dimensionLength', width: 'dimensionWidth', height: 'dimensionHeight' };

// A customer must never receive the stock level, the SKU or the retired flag.
const CUSTOMER_HIDDEN = { stockQuantity: true, sku: true, isActive: true };

const FALLBACK_IMAGE = '/fallback-product.png';

const VARIANT_ORDER = [{ position: 'asc' }, { id: 'asc' }];
const OPTIONS_INCLUDE = { orderBy: { position: 'asc' }, select: { name: true, values: true } };
const VARIANTS_INCLUDE = { orderBy: VARIANT_ORDER };
// What pricing and the public pages need of a variant: no stock or SKU is loaded.
const SELLING_VARIANTS_INCLUDE = { orderBy: VARIANT_ORDER, select: { id: true, optionValues: true, price: true, imageUrl: true, isActive: true } };
// Customers see the variants they can buy, without stock or SKU.
const CUSTOMER_VARIANTS_INCLUDE = {
	where: { isActive: true },
	orderBy: VARIANT_ORDER,
	select: { id: true, optionValues: true, price: true, imageUrl: true }
};
const FULL_INCLUDE = { options: OPTIONS_INCLUDE, variants: VARIANTS_INCLUDE };
const CUSTOMER_INCLUDE = { options: OPTIONS_INCLUDE, variants: CUSTOMER_VARIANTS_INCLUDE };

const clientOf = (tx) => tx || prisma;

// Optional fields a Mongo document simply lacks when they were never set.
const OMITTED_WHEN_NULL = new Set(['description', 'sku', 'weight', 'salePrice', 'saleStartDate', 'saleEndDate']);

/**
 * A variant as a plain record. `effectivePrice` is what one unit costs: its own
 * price, or the product's when it has none. `label` ("Đỏ / M") is absent for the
 * default variant, and so are a NULL price, SKU, image or archive date.
 */
function variantRecord(row, productPrice) {
	const { id, productId: _productId, position: _position, createdAt: _createdAt, updatedAt: _updatedAt, ...columns } = row;
	const record = { _id: id, ...Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== null)) };
	if (row.optionValues.length > 0) record.label = row.optionValues.join(' / ');
	if (productPrice !== undefined) record.effectivePrice = row.price ?? productPrice;
	return record;
}

/** A stored row as a plain record: `_id` is the uuid string, unset optional fields are absent. */
function toRecord(row) {
	const { id, dimensionLength, dimensionWidth, dimensionHeight, options, variants, ...rest } = row;
	const record = { _id: id };
	for (const [key, value] of Object.entries(rest)) {
		if (value === null && OMITTED_WHEN_NULL.has(key)) continue;
		record[key] = value;
	}
	if (options) record.options = options.map(({ name, values }) => ({ name, values }));
	if (variants) record.variants = variants.map((variant) => variantRecord(variant, row.price));
	const dimensions = Object.fromEntries(
		Object.entries({ length: dimensionLength, width: dimensionWidth, height: dimensionHeight }).filter(([, size]) => size !== null && size !== undefined)
	);
	if (Object.keys(dimensions).length > 0) record.dimensions = dimensions;
	return record;
}

/** Prisma `select` for the record fields a caller names; the id always comes along. */
function selectOf(fields) {
	const select = { id: true };
	for (const field of fields) {
		if (field === 'dimensions') Object.assign(select, { dimensionLength: true, dimensionWidth: true, dimensionHeight: true });
		else if (field === 'options') select.options = OPTIONS_INCLUDE;
		else if (field === 'variants') select.variants = SELLING_VARIANTS_INCLUDE;
		else if (field !== '_id') select[field] = true;
	}
	return select;
}

/** The one rule for "can be sold on this channel". @throws {TypeError} */
function sellableWhere(channel) {
	assertSaleChannel(channel);
	return { available: true, salesChannel: { in: ['all', channel] } };
}

/** The filter for one storefront's products; no storefront, no filter. @throws {InvalidIdError} */
function storefrontWhere(storefrontId) {
	return storefrontId === undefined || storefrontId === null ? {} : { storefrontId: recordId(storefrontId, 'storefrontId') };
}

/** The admin list's storefront filter; an id that cannot name a storefront matches nothing, as on the order list. */
function listStorefrontWhere(storefrontId) {
	try {
		return storefrontWhere(storefrontId);
	} catch {
		return { id: { in: [] } };
	}
}

/** "Contains `search`" over name or description, as a filter. No search, no filter. */
function searchWhere(search) {
	const text = asString(search, SEARCH_MAX_LENGTH);
	if (!text) return {};
	const match = containsInsensitive(text);
	return { OR: [{ name: match }, { description: match }] };
}

// `null` for a NOT NULL column means "not given": the default applies on create, the stored value stays on update.
const dropNull = (value) => (value === null ? undefined : value);

/**
 * Cleaned, validated column values for the fields present in `fields`. Required
 * fields are enforced when `creating`; on an edit only what is given is checked.
 *
 * @throws {RecordValidationError} every field that breaks a rule
 */
function columnsOf(fields, { creating }) {
	const problems = new Problems();
	const given = (name, required) => (creating && required && fields[name] === undefined ? null : fields[name]);

	const dimensionInput = fields.dimensions;
	const dimensions = {};
	if (dimensionInput !== undefined && dimensionInput !== null) {
		if (typeof dimensionInput !== 'object' || Array.isArray(dimensionInput)) problems.add('dimensions', 'Giá trị của "dimensions" không hợp lệ');
		else {
			for (const [axis, column] of Object.entries(DIMENSION_COLUMNS)) {
				dimensions[column] = checkNumber(problems, `dimensions.${axis}`, dimensionInput[axis], {});
			}
		}
	}

	let tags;
	if (fields.tags !== undefined && fields.tags !== null) {
		if (!Array.isArray(fields.tags)) problems.add('tags', 'Giá trị của "tags" không hợp lệ');
		else tags = fields.tags.map((tag) => checkText(problems, 'tags', tag, {}));
	}

	let publicCode;
	if (fields.publicCode !== undefined && fields.publicCode !== null) {
		publicCode = fields.publicCode;
		if (typeof publicCode !== 'string' || !PUBLIC_CODE_PATTERN.test(publicCode)) problems.add('publicCode', `Path \`publicCode\` is invalid (${String(publicCode)}).`);
	}

	const columns = {
		name: checkText(problems, 'name', given('name', true), {
			required: true, requiredMessage: 'Tên sản phẩm là bắt buộc', max: 100, maxMessage: 'Tên sản phẩm không được vượt quá 100 ký tự'
		}),
		description: checkText(problems, 'description', fields.description, { max: 500, maxMessage: 'Mô tả không được vượt quá 500 ký tự' }),
		price: checkNumber(problems, 'price', given('price', true), {
			required: true, requiredMessage: 'Giá sản phẩm là bắt buộc', min: 0, minMessage: 'Giá không được âm', integer: true, integerMessage: 'Giá phải là số nguyên (VND)'
		}),
		imageUrl: checkText(problems, 'imageUrl', dropNull(fields.imageUrl), { trim: false }),
		category: checkText(problems, 'category', given('category', true), {
			required: true, requiredMessage: 'Danh mục sản phẩm là bắt buộc', trim: false
		}),
		available: checkBoolean(problems, 'available', dropNull(fields.available)),
		isActive: checkBoolean(problems, 'isActive', dropNull(fields.isActive)),
		salesChannel: checkEnum(problems, 'salesChannel', dropNull(fields.salesChannel), SALES_CHANNELS),
		minOrderQuantity: checkNumber(problems, 'minOrderQuantity', dropNull(fields.minOrderQuantity), {
			min: 1, minMessage: 'Số lượng đặt hàng tối thiểu phải >= 1', integer: true, integerMessage: 'Số lượng đặt hàng tối thiểu phải là số nguyên'
		}),
		maxOrderQuantity: checkNumber(problems, 'maxOrderQuantity', fields.maxOrderQuantity, { integer: true, integerMessage: 'Số lượng đặt hàng tối đa phải là số nguyên' }),
		sku: checkText(problems, 'sku', fields.sku, {}),
		storefrontId: fields.storefrontId === undefined || fields.storefrontId === null ? undefined : recordId(fields.storefrontId, 'storefrontId'),
		tags,
		weight: checkNumber(problems, 'weight', fields.weight, { min: 0, minMessage: 'Trọng lượng không được âm' }),
		featured: checkBoolean(problems, 'featured', dropNull(fields.featured)),
		salePrice: checkNumber(problems, 'salePrice', fields.salePrice, {
			min: 0, minMessage: 'Giá khuyến mãi không được âm', integer: true, integerMessage: 'Giá khuyến mãi phải là số nguyên (VND)'
		}),
		saleStartDate: checkDate(problems, 'saleStartDate', fields.saleStartDate),
		saleEndDate: checkDate(problems, 'saleEndDate', fields.saleEndDate),
		...dimensions,
		publicCode
	};
	problems.throwIfAny();
	// The single image the API sends is the whole gallery; the cover CHECK needs both.
	if (columns.imageUrl === '') columns.imageUrl = FALLBACK_IMAGE;
	if (columns.imageUrl !== undefined && fields.images === undefined) columns.images = columns.imageUrl === FALLBACK_IMAGE ? [] : [columns.imageUrl];
	return Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));
}

/**
 * Sellable products on `channel`, oldest first, as plain records, optionally only
 * the one with this `publicCode` or `id`. The channel is validated before
 * anything is queried and the error is thrown synchronously.
 *
 * @param {'online'|'offline'} channel
 * @param {{publicCode?: string, id?: string, storefrontId?: string}} [options]
 * @returns {Promise<object[]>}
 * @throws {TypeError} channel missing or unknown
 */
function findSellable(channel, { publicCode, id, storefrontId } = {}) {
	const sellable = sellableWhere(channel);
	return translating(async () => {
		const where = { ...sellable, ...storefrontWhere(storefrontId), ...(publicCode !== undefined && { publicCode }), ...(id !== undefined && { id: recordId(id) }) };
		const rows = await prisma.product.findMany({ where, include: FULL_INCLUDE, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
		return rows.map(toRecord);
	});
}

/**
 * Sellable products on `channel`, by category then name, optionally narrowed to
 * one category and to a name/description text. `forCustomers` leaves out the
 * stock level, the SKU and the retired `isActive` flag.
 *
 * @param {'online'|'offline'} channel
 * @param {{category?: string, search?: string, forCustomers?: boolean, storefrontId?: string}} [options]
 * @returns {Promise<object[]>}
 * @throws {TypeError} channel missing or unknown
 */
async function listSellable(channel, { category, search, forCustomers = false, storefrontId } = {}) {
	const where = { ...sellableWhere(channel), ...listStorefrontWhere(storefrontId), ...(category && { category }), ...searchWhere(search) };
	const rows = await prisma.product.findMany({
		where,
		...(forCustomers ? { omit: CUSTOMER_HIDDEN, include: CUSTOMER_INCLUDE } : { include: FULL_INCLUDE }),
		orderBy: [{ category: 'asc' }, { name: 'asc' }, { id: 'asc' }]
	});
	return rows.map(toRecord);
}

/**
 * The sellable products with these ids, for pricing: only the named fields are
 * loaded, `_id` is the lowercase uuid string.
 *
 * @param {'online'|'offline'} channel
 * @param {string[]} ids record ids, uuid or legacy hex; mapped here so a caller that skipped normalising cannot reach Postgres with a 22P02
 * @param {string[]} fields
 * @param {object|null} [tx]
 * @param {{storefrontId?: string}} [options] only the products of this storefront
 * @returns {Promise<object[]>}
 */
function findSellableForPricing(channel, ids, fields, tx, { storefrontId } = {}) {
	return translating(async () => {
		const productIds = ids.map((id) => recordId(id));
		const where = { id: { in: productIds }, ...sellableWhere(channel), ...storefrontWhere(storefrontId) };
		// Inside an order's transaction the priced variants stay until it commits: a
		// DELETE of a variant takes a row lock that conflicts with KEY SHARE, while the
		// ledger's NO KEY UPDATE does not wait on it. Taken in id order, like every
		// other multi-row lock, so two lockers cannot cross.
		if (tx && fields.includes('variants')) {
			await tx.$queryRaw`SELECT id FROM product_variants WHERE product_id = ANY(${productIds}::uuid[]) ORDER BY id FOR KEY SHARE`;
		}
		const rows = await clientOf(tx).product.findMany({ where, select: selectOf(fields) });
		return rows.map(toRecord);
	});
}

/**
 * The distinct storefronts of the existing products with these ids, whatever their
 * channel or availability, so an access check can run before any price or product
 * name is worked out. Ids that match no product add nothing.
 *
 * @param {string[]} ids record ids, uuid or legacy hex
 * @param {object|null} [tx]
 * @returns {Promise<Array<string|null>>} lowercase storefront ids (null for a row that has none)
 */
function storefrontIdsOf(ids, tx) {
	return translating(async () => {
		const rows = await clientOf(tx).product.findMany({
			where: { id: { in: ids.map((id) => recordId(id)) } },
			select: { storefrontId: true },
			distinct: ['storefrontId']
		});
		return rows.map((row) => row.storefrontId);
	});
}

/** Names of the products with these ids that are switched on, whatever channel they sell on. */
function findAvailableNames(ids, tx) {
	return translating(async () => {
		const rows = await clientOf(tx).product.findMany({ where: { id: { in: ids.map((id) => recordId(id)) }, available: true }, select: { name: true } });
		return rows.map((row) => row.name);
	});
}

/** Sellable products in any of `categories`, by name. */
async function listSellableInCategories(channel, categories, fields) {
	const rows = await prisma.product.findMany({
		where: { category: { in: categories }, ...sellableWhere(channel) },
		select: selectOf(fields),
		orderBy: [{ name: 'asc' }, { id: 'asc' }]
	});
	return rows.map(toRecord);
}

/** Every category in use, unordered. */
async function listCategories() {
	const groups = await prisma.product.groupBy({ by: ['category'] });
	return groups.map((group) => group.category);
}

/**
 * The page of products an admin manages, newest first (ties by id, so a page
 * boundary never repeats or drops a row). `salesChannel` filters on the channel
 * the admin set, not on sellability.
 *
 * `total` and `data` are read in parallel, not from one snapshot, so a concurrent
 * write can make them disagree by a row. Accepted: the list is advisory.
 *
 * @param {{page: number, limit: number, search?: string, category?: string, available?: boolean, salesChannel?: string, storefrontId?: string}} query
 * @returns {Promise<{data: object[], meta: {page: number, limit: number, total: number, totalPages: number}}>}
 */
async function listPage({ page, limit, search, category, available, salesChannel, storefrontId }) {
	// A channel the enum does not have matches nothing, as it does on Mongo.
	const channel = !salesChannel ? {} : SALES_CHANNELS.includes(salesChannel) ? { salesChannel } : { id: { in: [] } };
	const where = { ...searchWhere(search), ...channel, ...listStorefrontWhere(storefrontId), ...(category && { category }), ...(available !== undefined && { available }) };

	const { skip, take } = toSkipTake(page, limit);
	const [rows, total] = await Promise.all([
		prisma.product.findMany({ where, include: FULL_INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take }),
		prisma.product.count({ where })
	]);
	return { data: rows.map(toRecord), meta: buildPaginationMeta(total, { page, limit }) };
}

/**
 * How many products there are, how many are available and the cached stock of
 * all of them together. Two statements, not one snapshot.
 *
 * @returns {Promise<{total: number, active: number, totalStock: number}>}
 */
async function summarizeCatalog() {
	const [all, active] = await Promise.all([
		prisma.product.aggregate({ _count: { _all: true }, _sum: { stockQuantity: true } }),
		prisma.product.count({ where: { available: true } })
	]);
	return { total: all._count._all, active, totalStock: all._sum.stockQuantity ?? 0 };
}

/** The id of every product, unordered. */
async function listIds() {
	const rows = await prisma.product.findMany({ select: { id: true } });
	return rows.map((row) => row.id);
}

/** Id and category of every product. */
async function listCategoryById() {
	const rows = await prisma.product.findMany({ select: { id: true, category: true } });
	return rows.map(toRecord);
}

/** True when a product with this id exists. @throws {InvalidIdError} */
async function exists(id) {
	return (await prisma.product.findUnique({ where: { id: recordId(id) }, select: { id: true } })) !== null;
}

/** True when a product with this name exists (exact match). */
async function existsByName(name) {
	return (await prisma.product.findFirst({ where: { name }, select: { id: true } })) !== null;
}

/** The product with this id, or null. @throws {InvalidIdError} */
function findById(id) {
	return translating(async () => {
		const row = await prisma.product.findUnique({ where: { id: recordId(id) }, include: FULL_INCLUDE });
		return row ? toRecord(row) : null;
	});
}

/**
 * Insert a product whose stock cache starts at `openingStock`. The caller records
 * the matching applied `opening` movement in the same `tx`, so cache and ledger
 * agree from the first moment. A code is drawn once: a collision rejects with
 * `DuplicateKeyError(publicCode)` and the caller reruns its transaction, because
 * Postgres has aborted it. A supplied `_id` (an import) may be a legacy hex id.
 *
 * @param {object} fields what the request chose, defaults resolved
 * @param {number} openingStock
 * @param {object|null} tx
 * @returns {Promise<object>}
 * @throws {RecordValidationError|DuplicateKeyError|InvalidIdError}
 */
function create(fields, openingStock, tx) {
	return translating(async () => {
		const problems = new Problems();
		const opening = checkNumber(problems, 'openingStock', openingStock, { integer: true, integerMessage: 'Tồn kho ban đầu phải là số nguyên' });
		const { publicCode: supplied, ...columns } = columnsOf(fields, { creating: true });
		problems.throwIfAny();

		const row = await clientOf(tx).product.create({
			data: {
				...columns,
				storefrontId: columns.storefrontId ?? DEFAULT_STOREFRONT_ID,
				...drawCodeAndSlug(columns.name, supplied),
				...(fields._id !== undefined && { id: recordId(fields._id) }),
				stockQuantity: opening ?? undefined,
				// Every product starts with its default variant, which holds the opening stock.
				variants: { create: { position: 0, optionValues: [], stockQuantity: opening ?? undefined } }
			},
			include: FULL_INCLUDE
		});
		return toRecord(row);
	});
}

/**
 * Apply `changes` (only the editable fields are taken) and return the product as
 * stored afterwards, or null when it does not exist. A rename recomputes the slug
 * from the stored code; `publicCode` is never written.
 *
 * @param {string} id
 * @param {object} changes
 * @returns {Promise<object|null>}
 * @throws {RecordValidationError|DuplicateKeyError|InvalidIdError}
 */
function update(id, changes) {
	const picked = Object.fromEntries(EDITABLE_FIELDS.filter((field) => changes[field] !== undefined).map((field) => [field, changes[field]]));
	return translating(async () => {
		const productId = recordId(id);
		const columns = columnsOf(picked, { creating: false });
		if (columns.name !== undefined) {
			const stored = await prisma.product.findUnique({ where: { id: productId }, select: { publicCode: true } });
			if (!stored) return null;
			columns.slug = slugFor(columns.name, stored.publicCode);
		}
		try {
			return toRecord(await prisma.product.update({ where: { id: productId }, data: columns, include: FULL_INCLUDE }));
		} catch (err) {
			// Deleted between the lookup and the write.
			if (err && err.code === 'P2025') return null;
			throw err;
		}
	});
}

/** Delete the product with this id; false when there was none. @throws {InvalidIdError} */
function remove(id) {
	return translating(async () => (await prisma.product.deleteMany({ where: { id: recordId(id) } })).count === 1);
}

module.exports = {
	toRecord,
	FULL_INCLUDE,
	FALLBACK_IMAGE,
	SALES_CHANNELS,
	assertSaleChannel,
	findSellable,
	listSellable,
	listCategories,
	listIds,
	listCategoryById,
	...publicCodeBackfill(() => prisma.product),
	listPage,
	summarizeCatalog,
	exists,
	existsByName,
	findById,
	create,
	update,
	remove,
	findSellableForPricing,
	storefrontIdsOf,
	findAvailableNames,
	listSellableInCategories
};
