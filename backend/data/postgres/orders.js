/**
 * Orders on Postgres, as plain records (record shape: data/postgres/order-records.js).
 *
 * Concurrency. An order is changed by taking its row lock first
 * (`SELECT ... FOR NO KEY UPDATE`: it blocks other writers of the same order but
 * not the foreign-key checks of child rows, which take only KEY SHARE), then by a
 * compare-and-set `updateMany` whose `count` must be 1, then by the child row
 * with `position = count`. Under Read Committed a blocked writer re-reads after
 * the winner commits, so:
 * - `findById(id, tx)` takes the lock itself. A cancel racing a delivery both read
 *   the order through it, so the loser waits there, then sees the winner's
 *   status and answers `final` instead of a spurious `conflict`;
 * - `applyStatusChange` / `replaceItems` lock again (a no-op in the same
 *   transaction) so a caller that skipped the read is still serialised, and keep
 *   the `where` predicate as the independent check;
 * - `position = count` is safe only because the lock serialises writers of one
 *   order; the unique `(order_id, position)` index turns a missed lock into an
 *   error instead of a silent overwrite.
 * An order transaction takes this one order lock and never a product row lock,
 * and the ledger applier takes movement then product, so the two cannot cycle.
 *
 * Reads of lists are two statements (rows, count), not one snapshot.
 */
const { prisma } = require('../../lib/prisma');
const { Prisma } = require('../../generated/prisma/client');
const { toSkipTake, buildPaginationMeta } = require('@sab/shared');
const { asString } = require('../../utils/query-guard');
const { translating } = require('./errors');
const { withTransaction } = require('./tx');
const { containsInsensitive } = require('./like');
const { recordId } = require('./rules');
const { includeFor, toRecord, itemRecord } = require('./order-records');
const fields = require('./order-fields');

const { STATUS_VALUES } = fields;
const FINAL_ORDER_STATUSES = ['cancelled', 'delivered'];

const SEARCH_FIELDS = ['orderNumber', 'orderCode', 'fullName', 'studentId', 'email'];
const SORT_FIELDS = ['createdAt', 'totalAmount', 'status', 'orderCode', 'orderNumber'];
const SEARCH_MAX_LENGTH = 100;
const PRODUCT_FIELDS = new Set(Object.keys(Prisma.ProductScalarFieldEnum));

const clientOf = (tx) => tx || prisma;
const inTransaction = (tx, work) => (tx ? work(tx) : withTransaction(work));

/** Takes the order's row lock; false when there is no such order. */
async function lockOrder(client, id) {
	const rows = await client.$queryRaw`SELECT id FROM orders WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
	return rows.length === 1;
}

async function readOrder(client, id, omit) {
	const row = await client.order.findUnique({ where: { id }, include: includeFor(omit) });
	return row ? toRecord(row) : null;
}

/** The records with `productFields` of each line's product attached (see data/index.js). One product query for all records. */
async function attachProductsToAll(records, productFields) {
	const unknown = productFields.find((field) => !PRODUCT_FIELDS.has(field));
	if (unknown !== undefined) throw new TypeError(`Invalid product field: ${unknown}`);

	const ids = new Set();
	for (const record of records) {
		for (const item of record.items || []) ids.add(item.productId);
	}
	const select = { id: true, ...Object.fromEntries(productFields.map((field) => [field, true])) };
	const rows = ids.size === 0 ? [] : await prisma.product.findMany({ where: { id: { in: [...ids] } }, select });
	const byId = new Map(rows.map(({ id, ...rest }) => [id, { _id: id, ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== null)) }]));

	return records.map((record) => (record.items
		? { ...record, items: record.items.map((item) => ({ ...item, productId: byId.get(item.productId) ?? null })) }
		: record));
}

/** One order record with `productFields` of each line's product attached. */
async function attachProducts(order, productFields) {
	return (await attachProductsToAll([order], productFields))[0];
}

const finish = async (rows, withProducts) => {
	const records = rows.map(toRecord);
	return withProducts ? attachProductsToAll(records, withProducts) : records;
};

/** The order as stored, as a plain object with a string `_id`, or null. In a transaction it also takes the order's row lock (see the header). @throws {InvalidIdError} */
function findById(orderId, tx) {
	return translating(async () => {
		const id = recordId(orderId);
		if (tx) await lockOrder(tx, id);
		return readOrder(clientOf(tx), id);
	});
}

/** One order for a response, or null. `complete` changes nothing here: every column has its default. @throws {InvalidIdError} */
function findDetail(orderId, { omit = [], withProducts } = {}) {
	return translating(async () => {
		const row = await prisma.order.findUnique({ where: { id: recordId(orderId) }, include: includeFor(omit) });
		return row ? (await finish([row], withProducts))[0] : null;
	});
}

/** The order with this code (as stored, so already uppercase), or null. */
async function findByCode(orderCode) {
	const row = await prisma.order.findUnique({ where: { orderCode }, include: includeFor() });
	return row ? toRecord(row) : null;
}

/** True when an order has this code (compared as stored, so already uppercase). */
async function existsByCode(orderCode) {
	return (await prisma.order.findUnique({ where: { orderCode }, select: { id: true } })) !== null;
}

/** Orders of one storefront; an id that cannot name one matches nothing, as an unknown status does. */
function storefrontFilter(storefrontId) {
	try {
		return { storefrontId: recordId(storefrontId, 'storefrontId') };
	} catch {
		return { id: { in: [] } };
	}
}

/** The filter shared by the paged list and the full export; validates what it is given. */
function listWhere({ status, search, searchFields = [], createdFrom, createdTo, storefrontId }) {
	if (status !== undefined && typeof status !== 'string') throw new TypeError('status must be a string');
	const badField = searchFields.find((field) => !SEARCH_FIELDS.includes(field));
	if (badField !== undefined) throw new TypeError(`Cannot search order field: ${badField}`);

	const text = asString(search, SEARCH_MAX_LENGTH);
	const match = text ? containsInsensitive(text) : undefined;
	return {
		// A status the enum does not have matches nothing instead of raising an error.
		...(status && (STATUS_VALUES.includes(status) ? { status } : { id: { in: [] } })),
		...(storefrontId !== undefined && storefrontFilter(storefrontId)),
		...(match && searchFields.length > 0 && { OR: searchFields.map((field) => ({ [field]: match })) }),
		...((createdFrom || createdTo) && { createdAt: { ...(createdFrom && { gte: createdFrom }), ...(createdTo && { lte: createdTo }) } })
	};
}

/** @returns {{field: string, direction: 'asc'|'desc'}} the one sort entry, validated */
function sortOf(sort) {
	const [[field, direction] = [], ...extra] = Object.entries(sort);
	if (extra.length > 0 || !SORT_FIELDS.includes(field) || (direction !== 1 && direction !== -1)) {
		throw new TypeError(`Unsupported order sort: ${JSON.stringify(sort)}`);
	}
	return { field, direction: direction === 1 ? 'asc' : 'desc' };
}

/**
 * Prisma `orderBy` for a sort: the id follows the direction and breaks ties, so a
 * page boundary never repeats or drops a row. A missing `orderNumber` sorts first
 * ascending and last descending, so a missing value always reads as the smallest.
 */
function orderByOf({ field, direction }) {
	const key = field === 'orderNumber' ? { orderNumber: { sort: direction, nulls: direction === 'asc' ? 'first' : 'last' } } : { [field]: direction };
	return [key, { id: direction }];
}

/**
 * A page sorted by status. The enum sorts by declaration order in Postgres, which is not
 * alphabetical, and Prisma cannot cast in `orderBy`, so the statuses
 * are walked in alphabetical order: a grouped count says how many rows each holds
 * and one bounded `findMany` per status covers the page.
 */
async function pageByStatus({ where, direction, skip, take, include }) {
	const groups = await prisma.order.groupBy({ by: ['status'], where, _count: { _all: true } });
	const sign = direction === 'asc' ? 1 : -1;
	groups.sort((a, b) => (a.status < b.status ? -sign : sign));

	const rows = [];
	let total = 0;
	let offset = skip;
	let remaining = take;
	for (const group of groups) {
		const size = group._count._all;
		total += size;
		if (remaining === 0) continue;
		if (offset >= size) {
			offset -= size;
			continue;
		}
		const slice = await prisma.order.findMany({ where: { ...where, status: group.status }, orderBy: { id: direction }, skip: offset, take: remaining, include });
		rows.push(...slice);
		remaining -= slice.length;
		offset = 0;
	}
	return { rows, total };
}

/**
 * One page of orders and the count of every match. Rows sort by `sort` and then
 * by id. A `search` matches the text anywhere in any of `searchFields`.
 *
 * @param {{page: number, limit: number, sort: Object<string, 1|-1>, status?: string,
 *          search?: string, searchFields?: string[], createdFrom?: Date, createdTo?: Date,
 *          storefrontId?: string, omit?: string[], withProducts?: string[]}} query `sort` has one entry:
 *          `createdAt`, `totalAmount`, `status`, `orderCode` or `orderNumber`; `createdTo` is inclusive
 * @returns {Promise<{data: object[], meta: object}>}
 */
async function listPage({ page, limit, sort, status, search, searchFields = [], createdFrom, createdTo, storefrontId, omit = [], withProducts }) {
	const where = listWhere({ status, search, searchFields, createdFrom, createdTo, storefrontId });
	const ordering = sortOf(sort);
	const include = includeFor(omit);
	const { skip, take } = toSkipTake(page, limit);

	const { rows, total } = ordering.field === 'status'
		? await pageByStatus({ where, direction: ordering.direction, skip, take, include })
		: await Promise.all([
			prisma.order.findMany({ where, orderBy: orderByOf(ordering), skip, take, include }),
			prisma.order.count({ where })
		]).then(([found, count]) => ({ rows: found, total: count }));
	return { data: await finish(rows, withProducts), meta: buildPaginationMeta(total, { page, limit }) };
}

/** Every order that matches, newest first. Not paged: the export wants them all. */
async function listAll(query = {}) {
	const rows = await prisma.order.findMany({ where: listWhere(query), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: includeFor() });
	return rows.map(toRecord);
}

/** The newest `limit` orders. */
async function listRecent({ limit, omit = [], withProducts }) {
	const rows = await prisma.order.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, include: includeFor(omit) });
	return finish(rows, withProducts);
}

/**
 * Order counts since each boundary, delivered revenue and the number of orders
 * per status.
 *
 * @param {{todayFrom: Date, weekFrom: Date, monthFrom: Date}} since
 */
async function summarize({ todayFrom, weekFrom, monthFrom }) {
	const [total, today, week, month, delivered, revenue, byStatus] = await Promise.all([
		prisma.order.count(),
		prisma.order.count({ where: { createdAt: { gte: todayFrom } } }),
		prisma.order.count({ where: { createdAt: { gte: weekFrom } } }),
		prisma.order.count({ where: { createdAt: { gte: monthFrom } } }),
		prisma.order.count({ where: { status: 'delivered' } }),
		prisma.order.aggregate({ where: { status: 'delivered' }, _sum: { totalAmount: true } }),
		prisma.order.groupBy({ by: ['status'], _count: { _all: true }, orderBy: { status: 'asc' } })
	]);
	return {
		total,
		today,
		week,
		month,
		delivered,
		deliveredRevenue: revenue._sum.totalAmount ?? 0,
		byStatus: byStatus.map((entry) => ({ status: entry.status, count: entry._count._all }))
	};
}

/**
 * The highest `SAB######` order number, or null when no order has one. Taken
 * inside the creating transaction; two sellers reading the same maximum clash on
 * the unique `order_number` and the loser reruns its transaction.
 */
async function latestOrderNumber(tx) {
	const rows = await clientOf(tx).$queryRaw`SELECT max(order_number) AS last FROM orders WHERE order_number ~ '^SAB[0-9]{6}$'`;
	return rows[0].last ?? null;
}

/**
 * Stores a new order and returns it. The schema's rules (trim, case, required,
 * length) are applied here because the merge import reaches this without request
 * validation.
 *
 * @param {object} orderFields
 * @param {object} [tx] outside a transaction when omitted
 * @throws {DuplicateKeyError} `fields` names `orderCode` or `orderNumber`
 * @throws {RecordValidationError|InvalidIdError}
 */
function create(orderFields, tx) {
	return translating(async () => {
		const { columns, items, statusHistory, internalNotes, itemsEdits } = fields.newOrder(orderFields);
		const positioned = (rows) => ({ create: rows.map((row, position) => ({ ...row, position })) });
		const row = await clientOf(tx).order.create({
			data: {
				...columns,
				items: positioned(items),
				statusHistory: positioned(statusHistory),
				internalNotes: positioned(internalNotes),
				itemsEdits: positioned(itemsEdits)
			},
			include: includeFor()
		});
		return toRecord(row);
	});
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
	return translating(async () => {
		const id = recordId(orderId);
		const note = additionalNote === undefined ? undefined : fields.additionalNoteOf(additionalNote);
		const entry = internalNote === undefined ? undefined : fields.noteRow(internalNote);
		return withTransaction(async (tx) => {
			if (!(await lockOrder(tx, id))) return null;
			await tx.order.update({ where: { id }, data: note === undefined ? {} : { additionalNote: note } });
			if (entry) {
				const position = await tx.orderInternalNote.count({ where: { orderId: id } });
				await tx.orderInternalNote.create({ data: { ...entry, orderId: id, position } });
			}
			return readOrder(tx, id);
		});
	});
}

/**
 * Orders that carry a discounted combo, in either stored shape of `comboInfo`,
 * with the fields the pricing audit reads.
 */
async function listWithCombo() {
	const rows = await prisma.order.findMany({
		where: { comboInfo: { not: Prisma.DbNull } },
		select: { id: true, orderCode: true, status: true, totalAmount: true, comboInfo: true, createdAt: true, items: { orderBy: { position: 'asc' } } }
	});
	const hasCombo = ({ comboInfo }) => comboInfo.comboId != null || (Array.isArray(comboInfo.combos) && comboInfo.combos.length > 0);
	return rows.filter(hasCombo).map((row) => {
		const { orderCode, status, totalAmount, comboInfo, createdAt } = row;
		return { _id: row.id, orderCode, status, totalAmount, items: row.items.map(itemRecord), comboInfo, createdAt };
	});
}

// `stock_deducted` is NOT NULL here, so no order can predate the flag.
async function countMissingStockDeducted() {
	return { missing: 0, direct: 0, web: 0 };
}

async function backfillStockDeducted() {
	return { markedDeducted: 0, markedNotDeducted: 0 };
}

/** The number of orders. */
function count() {
	return prisma.order.count();
}

/** Deletes every order (and its child rows) and returns how many were deleted. */
async function deleteAll() {
	const { count: deletedCount } = await prisma.order.deleteMany({});
	return { deletedCount };
}

/**
 * Compare-and-set a status change: stores `changes` and appends `historyEntry`
 * only when the order still has `fromStatus`. Returns the updated order, or null
 * when another writer changed the status first (or there is no such order).
 *
 * @param {{orderId: string, fromStatus: string, fields: object, historyEntry: object}} change
 * @param {object} tx
 * @throws {RecordValidationError|TypeError}
 */
function applyStatusChange({ orderId, fromStatus, fields: changes, historyEntry }, tx) {
	return translating(async () => {
		const id = recordId(orderId);
		const columns = fields.statusChangeColumns(changes);
		const entry = fields.historyRow(historyEntry);
		// A status the enum does not have is never the current one.
		if (!STATUS_VALUES.includes(fromStatus)) return null;
		return inTransaction(tx, async (client) => {
			if (!(await lockOrder(client, id))) return null;
			const { count: updated } = await client.order.updateMany({ where: { id, status: fromStatus }, data: columns });
			if (updated !== 1) return null;
			const position = await client.orderStatusEntry.count({ where: { orderId: id } });
			await client.orderStatusEntry.create({ data: { ...entry, orderId: id, position } });
			return readOrder(client, id);
		});
	});
}

/**
 * Compare-and-set an item edit: replaces the items and combo info, bumps the
 * revision and appends `historyEntry` only when the order still has `fromStatus`
 * and `fromRevision`. Returns the updated order, or null when it moved.
 *
 * @param {{orderId: string, fromStatus: string, fromRevision: number, items: Array<object>,
 *          comboInfo: *, historyEntry: object}} edit
 * @param {object} tx
 * @throws {RecordValidationError}
 */
function replaceItems({ orderId, fromStatus, fromRevision, items, comboInfo, historyEntry }, tx) {
	return translating(async () => {
		const id = recordId(orderId);
		const lines = fields.lineRows(items);
		const entry = fields.editRow(historyEntry);
		if (!STATUS_VALUES.includes(fromStatus)) return null;
		return inTransaction(tx, async (client) => {
			if (!(await lockOrder(client, id))) return null;
			const { count: updated } = await client.order.updateMany({
				where: { id, status: fromStatus, itemsRevision: fromRevision },
				data: { comboInfo: fields.jsonOrNull(comboInfo), itemsRevision: { increment: 1 } }
			});
			if (updated !== 1) return null;
			await client.orderItem.deleteMany({ where: { orderId: id } });
			await client.orderItem.createMany({ data: lines.map((line, position) => ({ ...line, orderId: id, position })) });
			const position = await client.orderItemsEdit.count({ where: { orderId: id } });
			await client.orderItemsEdit.create({ data: { ...entry, orderId: id, position } });
			return readOrder(client, id);
		});
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
	listWithCombo,
	countMissingStockDeducted,
	backfillStockDeducted,
	count,
	deleteAll,
	applyStatusChange,
	replaceItems,
	attachProducts
};
