/**
 * Orders. A `tx` is the transaction handed out by `withTransaction`; a function
 * that takes one must run inside it so its reads and writes see the same
 * snapshot. Everything returns plain records (see data/index.js).
 *
 * Read options shared by the list and detail reads:
 * - `omit`: fields left out of the record (`internalNotes`, `itemsHistory`).
 * - `withProducts`: product fields to attach. Each `items[].productId` becomes
 *   `{ _id, ...fields }`, or `null` when the product no longer exists.
 * - `complete`: apply the schema defaults to stored fields, as a document read
 *   does. A SQL backend always returns complete rows and ignores it.
 */
const Order = require('../../models/Order');
const Product = require('../../models/Product');
const { withStringId, toRecord } = require('./records');
const { translating } = require('./errors');
const { safeSearch } = require('../../utils/query-guard');
const { toSkipTake, buildPaginationMeta } = require('@sab/shared');

const { FINAL_ORDER_STATUSES } = Order;
const STATUS_VALUES = Order.schema.path('status').enumValues;

const SEARCH_FIELDS = ['orderNumber', 'orderCode', 'fullName', 'studentId', 'email'];
const SORT_FIELDS = ['createdAt', 'totalAmount', 'status', 'orderCode', 'orderNumber'];
const OMITTABLE_FIELDS = ['internalNotes', 'itemsHistory'];
const PRODUCT_FIELD = /^[A-Za-z]\w*$/;

/** Mongo projection that leaves out `omit`, or '' for all fields. */
function omission(omit) {
	const unknown = omit.find((field) => !OMITTABLE_FIELDS.includes(field));
	if (unknown !== undefined) throw new TypeError(`Cannot omit order field: ${unknown}`);
	return omit.map((field) => `-${field}`).join(' ');
}

/** `{ [field]: direction, _id: direction }`: the id keeps a page boundary from repeating or dropping a row. */
function orderBy(sort) {
	const [[field, direction] = [], ...extra] = Object.entries(sort);
	if (extra.length > 0 || !SORT_FIELDS.includes(field) || (direction !== 1 && direction !== -1)) {
		throw new TypeError(`Unsupported order sort: ${JSON.stringify(sort)}`);
	}
	return { [field]: direction, _id: direction };
}

/** The records with `fields` of each line's product attached (see the header). One product query for all records. */
async function attachProductsToAll(records, fields) {
	const unknown = fields.find((field) => !PRODUCT_FIELD.test(field));
	if (unknown !== undefined) throw new TypeError(`Invalid product field: ${unknown}`);

	const ids = new Set();
	for (const record of records) {
		for (const item of record.items || []) {
			if (item.productId != null) ids.add(String(item.productId));
		}
	}
	const products = ids.size === 0 ? [] : await Product.find({ _id: { $in: [...ids] } }).select(fields.join(' ')).lean();
	const byId = new Map(products.map((product) => [String(product._id), withStringId(product)]));

	return records.map((record) => (record.items
		? { ...record, items: record.items.map((item) => ({ ...item, productId: byId.get(String(item.productId)) ?? null })) }
		: record));
}

/** One order record with `fields` of each line's product attached (see the header). */
async function attachProducts(order, fields) {
	return (await attachProductsToAll([order], fields))[0];
}

/** Rows of a read, as records, honouring `complete` and `withProducts`. */
async function toRecords(rows, { complete, withProducts }) {
	const records = rows.map(complete ? toRecord : withStringId);
	return withProducts ? attachProductsToAll(records, withProducts) : records;
}

/** Applies `omit` and `complete` to a find query. */
function shaped(query, { omit, complete }) {
	const projection = omission(omit);
	if (projection) query.select(projection);
	return complete ? query : query.lean();
}

/**
 * The order as stored, as a plain object with a string `_id`, or null.
 *
 * @param {string} orderId
 * @param {object} tx
 * @throws {InvalidIdError}
 */
function findById(orderId, tx) {
	return translating(async () => {
		const order = await Order.findById(orderId).session(tx).lean();
		return order ? withStringId(order) : null;
	});
}

/**
 * One order for a response, or null.
 *
 * @param {string} orderId
 * @param {{omit?: string[], withProducts?: string[], complete?: boolean}} [options]
 * @throws {InvalidIdError}
 */
function findDetail(orderId, { omit = [], withProducts, complete = false } = {}) {
	return translating(async () => {
		const row = await shaped(Order.findById(orderId), { omit, complete });
		return row ? (await toRecords([row], { complete, withProducts }))[0] : null;
	});
}

/** The order with this code (as stored, so already uppercase), with the schema defaults applied, or null. */
async function findByCode(orderCode) {
	const order = await Order.findOne({ orderCode });
	return order ? toRecord(order) : null;
}

/** The filter shared by the paged list and the full export; validates what it is given. */
function listFilter({ status, search, searchFields = [], createdFrom, createdTo }) {
	if (status !== undefined && typeof status !== 'string') throw new TypeError('status must be a string');
	const badField = searchFields.find((field) => !SEARCH_FIELDS.includes(field));
	if (badField !== undefined) throw new TypeError(`Cannot search order field: ${badField}`);

	const match = safeSearch(search);
	return {
		...(status && { status }),
		...(match && searchFields.length > 0 && { $or: searchFields.map((field) => ({ [field]: match })) }),
		...((createdFrom || createdTo) && {
			createdAt: { ...(createdFrom && { $gte: createdFrom }), ...(createdTo && { $lte: createdTo }) }
		})
	};
}

/**
 * One page of orders and the count of every match. Rows sort by `sort` and then
 * by id. A `search` matches the text anywhere in any of `searchFields`.
 *
 * @param {{page: number, limit: number, sort: Object<string, 1|-1>, status?: string,
 *          search?: string, searchFields?: string[], createdFrom?: Date, createdTo?: Date,
 *          omit?: string[], withProducts?: string[], complete?: boolean}} query `sort` has one entry:
 *          `createdAt`, `totalAmount`, `status`, `orderCode` or `orderNumber`; `createdTo` is inclusive
 * @returns {Promise<{data: object[], meta: object}>}
 */
async function listPage({
	page, limit, sort, status, search, searchFields = [], createdFrom, createdTo, omit = [], withProducts, complete = false
}) {
	const filter = listFilter({ status, search, searchFields, createdFrom, createdTo });

	// `total` and `data` are read in parallel, not from one snapshot, so a concurrent
	// write can make them disagree by a row. Accepted: the list is advisory.
	const { skip, take } = toSkipTake(page, limit);
	const [rows, total] = await Promise.all([
		shaped(Order.find(filter).sort(orderBy(sort)).skip(skip).limit(take), { omit, complete }),
		Order.countDocuments(filter)
	]);
	return { data: await toRecords(rows, { complete, withProducts }), meta: buildPaginationMeta(total, { page, limit }) };
}

/**
 * Every order that matches, newest first, as stored (no defaults applied). Not
 * paged: the export wants them all. Filters work as in `listPage`.
 *
 * @param {{status?: string, search?: string, searchFields?: string[], createdFrom?: Date, createdTo?: Date}} [query]
 * @returns {Promise<object[]>}
 */
async function listAll(query = {}) {
	const rows = await Order.find(listFilter(query)).sort({ createdAt: -1 }).lean();
	return rows.map(withStringId);
}

/** The newest `limit` orders. */
async function listRecent({ limit, omit = [], withProducts }) {
	const rows = await shaped(Order.find().sort({ createdAt: -1, _id: -1 }).limit(limit), { omit, complete: false });
	return toRecords(rows, { complete: false, withProducts });
}

/**
 * Order counts since each boundary, delivered revenue and the number of orders
 * per status.
 *
 * @param {{todayFrom: Date, weekFrom: Date, monthFrom: Date}} since
 * @returns {Promise<{total: number, today: number, week: number, month: number, delivered: number,
 *          deliveredRevenue: number, byStatus: {status: string, count: number}[]}>}
 */
async function summarize({ todayFrom, weekFrom, monthFrom }) {
	const [total, today, week, month, delivered, revenue, byStatus] = await Promise.all([
		Order.countDocuments(),
		Order.countDocuments({ createdAt: { $gte: todayFrom } }),
		Order.countDocuments({ createdAt: { $gte: weekFrom } }),
		Order.countDocuments({ createdAt: { $gte: monthFrom } }),
		Order.countDocuments({ status: 'delivered' }),
		Order.aggregate([
			{ $match: { status: 'delivered' } },
			{ $group: { _id: null, total: { $sum: '$totalAmount' } } }
		]),
		Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
	]);
	return {
		total,
		today,
		week,
		month,
		delivered,
		deliveredRevenue: revenue[0]?.total || 0,
		byStatus: byStatus.map((entry) => ({ status: entry._id, count: entry.count }))
	};
}

/** True when an order has this code (compared as stored, so already uppercase). */
async function existsByCode(orderCode) {
	return Boolean(await Order.exists({ orderCode }));
}

/**
 * The highest `SAB######` order number, or null when no order has one.
 *
 * @param {object} tx
 * @returns {Promise<string|null>}
 */
async function latestOrderNumber(tx) {
	const last = await Order.findOne(
		{ orderNumber: { $regex: /^SAB\d{6}$/ } },
		{ orderNumber: 1 }
	).sort({ orderNumber: -1 }).session(tx).lean();
	return last && last.orderNumber ? last.orderNumber : null;
}

/**
 * Stores a new order and returns it, with the schema defaults applied.
 *
 * @param {object} fields
 * @param {object} [tx] outside a transaction when omitted
 * @throws {DuplicateKeyError} `fields` names `orderCode` or `orderNumber`
 * @throws {RecordValidationError}
 */
function create(fields, tx) {
	return translating(async () => toRecord(await new Order(fields).save({ session: tx })));
}

/**
 * Edits the customer note and/or appends an internal note, whatever the status.
 * Returns the updated order, or null when there is none.
 *
 * @param {{orderId: string, additionalNote?: string, internalNote?: {note: string, by: string, at: Date}}} edit
 * @throws {InvalidIdError}
 * @throws {RecordValidationError}
 */
function updateNotes({ orderId, additionalNote, internalNote }) {
	const update = {};
	if (additionalNote !== undefined) update.$set = { additionalNote };
	if (internalNote !== undefined) update.$push = { internalNotes: internalNote };
	return translating(async () => {
		const order = await Order.findOneAndUpdate({ _id: orderId }, update, { new: true, runValidators: true });
		return order ? toRecord(order) : null;
	});
}

/** The number of orders. */
function count() {
	return Order.countDocuments();
}

/** Deletes every order and returns how many were deleted. */
async function deleteAll() {
	const result = await Order.deleteMany({});
	return { deletedCount: result.deletedCount };
}

/**
 * Compare-and-set a status change: stores `fields` and appends `historyEntry`
 * only when the order still has `fromStatus`. Returns the updated order, or
 * null when another writer changed the status first.
 *
 * @param {{orderId: string, fromStatus: string, fields: object, historyEntry: object}} change
 * @param {object} tx
 * @throws {RecordValidationError}
 */
function applyStatusChange({ orderId, fromStatus, fields, historyEntry }, tx) {
	return translating(async () => {
		const order = await Order.findOneAndUpdate(
			{ _id: orderId, status: fromStatus },
			{
				$set: fields,
				$push: { statusHistory: historyEntry }
			},
			{ new: true, runValidators: true, session: tx }
		);
		return order ? toRecord(order) : null;
	});
}

/**
 * Compare-and-set an item edit: replaces the items and combo info, bumps the
 * revision and appends `historyEntry` only when the order still has `fromStatus`
 * and `fromRevision`. Returns the updated order, or null when it moved.
 *
 * Revision 0 also matches an order stored before the field existed.
 *
 * @param {{orderId: string, fromStatus: string, fromRevision: number, items: Array<object>,
 *          comboInfo: *, historyEntry: object}} edit
 * @param {object} tx
 * @throws {RecordValidationError}
 */
function replaceItems({ orderId, fromStatus, fromRevision, items, comboInfo, historyEntry }, tx) {
	return translating(async () => {
		const order = await Order.findOneAndUpdate(
			{
				_id: orderId,
				status: fromStatus,
				// A missing field matches `null`, which is how a legacy order is found.
				itemsRevision: fromRevision === 0 ? { $in: [0, null] } : fromRevision
			},
			{
				$set: { items, comboInfo },
				$inc: { itemsRevision: 1 },
				$push: { itemsHistory: historyEntry }
			},
			{ new: true, runValidators: true, session: tx }
		);
		return order ? toRecord(order) : null;
	});
}

module.exports = {
	FINAL_ORDER_STATUSES,
	STATUS_VALUES,
	findById,
	findDetail,
	findByCode,
	existsByCode,
	listPage,
	listAll,
	listRecent,
	summarize,
	latestOrderNumber,
	create,
	updateNotes,
	count,
	deleteAll,
	applyStatusChange,
	replaceItems,
	attachProducts
};
