/**
 * Backup and restore of the store's business data on Postgres, in the wire form
 * of data/snapshot.js (same sections, same JSON; ids are uuid strings, dates ISO
 * strings, no `__v`).
 *
 * Export reads every section in one Repeatable Read transaction, so a stock
 * movement applied while it runs cannot leave the product cache and the ledger
 * disagreeing in the file.
 *
 * Restore replaces every section inside the caller's transaction. Ids of every
 * form are mapped to uuids with the function that mapped the rows when the store
 * moved from Mongo (`normalizeRecordId`): row ids, the ids a row points at, the
 * ids inside the JSON of `comboInfo` and the item-edit history, and the ids that
 * idempotency keys are built from. Mapping is by key, never by guess, and it
 * leaves a uuid unchanged, so a file exported here restores to itself.
 *
 * Rows are written as the file holds them, with no request rules: the file passed
 * `validateSnapshot`, and the CHECKs and unique indexes of the schema are the
 * last line. A product or combo without a public code (a file from before codes
 * existed) is given one, since the column is NOT NULL.
 *
 * Stock movements keep their order through `seq`: the restore reserves a block of
 * the sequence for them (the sequence only moves forward, so a restore that rolls
 * back leaves a gap and never a collision) and numbers them in file order.
 *
 * The file carries no storefront fields: an export leaves them out, and a restore
 * puts every product, every combo and every online order in the default storefront
 * (the one row a restore never deletes). Direct sales never get a storefront.
 *
 * An export from here holds uuid ids; the Mongo backend's id check accepts only
 * 24-hex, so it cannot be restored onto Mongo.
 */
const { prisma } = require('../../lib/prisma');
const { normalizeRecordId } = require('../ids');
const { DEFAULT_STOREFRONT_ID } = require('../default-storefront');
const { translating } = require('./errors');
const { withSnapshotTransaction, withTransaction } = require('./tx');
const { toRecord: productRecord } = require('./products');
const { toRecord: comboRecord } = require('./combos');
const { toRecord: settingsRecord } = require('./settings');
const { includeFor, toRecord: orderRecord } = require('./order-records');
const { drawCodeAndSlug, slugFor } = require('./public-code');
const { mapJsonIds, HEX_ID } = require('./json-ids');

const INSERT_CHUNK = 1000;

// The whole store is read (export) or written (restore) in one transaction, which
// outlasts the client's default 15 s cap on a large store.
const WHOLE_STORE_TX = { maxWait: 120000, timeout: 120000 };

/** The record with every Date as an ISO string, the way it serialises to JSON. */
function toWire(value) {
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(toWire);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toWire(inner)]));
}

/** The wire form has no storefront fields. */
const withoutStorefront = ({ storefrontId: _storefrontId, ...record }) => record;

/** A movement row as a wire record: `seq` stays internal, an unset column is an absent key. */
function movementWire(row) {
	const { id, seq: _seq, ...rest } = row;
	return { _id: id, ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== null)) };
}

/**
 * Every row of the business tables from one consistent read.
 *
 * @param {object} [outer] read inside this transaction (its isolation level, its
 *   uncommitted rows) instead of a snapshot transaction of its own
 * @returns {Promise<Record<string, Array<object>>>} section -> wire-form rows, oldest id first (movements in ledger order)
 */
function exportAll(outer) {
	const read = async (tx) => {
		const [products, combos, orders, movements, settings] = [
			await tx.product.findMany({ orderBy: { id: 'asc' } }),
			await tx.combo.findMany({ orderBy: { id: 'asc' }, include: { requirements: { orderBy: { position: 'asc' } } } }),
			await tx.order.findMany({ orderBy: { id: 'asc' }, include: includeFor() }),
			await tx.stockMovement.findMany({ orderBy: { seq: 'asc' } }),
			await tx.settings.findMany({ orderBy: { id: 'asc' } })
		];
		return {
			products: products.map((row) => toWire(withoutStorefront(productRecord(row)))),
			combos: combos.map((row) => toWire(comboRecord(row))),
			orders: orders.map((row) => toWire(withoutStorefront(orderRecord(row)))),
			stockMovements: movements.map((row) => toWire(movementWire(row))),
			settings: settings.map((row) => toWire(settingsRecord(row, { defaults: false })))
		};
	};
	return outer ? read(outer) : withSnapshotTransaction(read);
}

/**
 * How many rows each table holds, the login tables included: a count carries no
 * personal data or credential, unlike a row, which a snapshot never contains for
 * those two.
 *
 * @returns {Promise<{users: number, products: number, orders: number, accounts: number, combos: number}>}
 */
async function countRows() {
	const [users, products, orders, accounts, combos] = await Promise.all([
		prisma.user.count(),
		prisma.product.count(),
		prisma.order.count(),
		prisma.account.count(),
		prisma.combo.count()
	]);
	return { users, products, orders, accounts, combos };
}

// ---- wire -> rows ----

const present = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined));

/** `row` without nulls, with the named ISO-string fields as Dates. */
function cleaned(row, dateKeys) {
	const out = present(row);
	for (const key of dateKeys) {
		if (typeof out[key] === 'string') out[key] = new Date(out[key]);
	}
	return out;
}

const idOrUndefined = (value) => (value === null || value === undefined ? undefined : normalizeRecordId(value));

/** The segments of an idempotency key that are legacy ids, mapped; every other segment is kept. */
function mappedKey(key) {
	return key.split(':').map((part) => (HEX_ID.test(part) ? normalizeRecordId(part) : part)).join(':');
}

function productRow(product) {
	const { _id, __v, dimensions, publicCode, slug, ...rest } = product;
	return {
		...cleaned(rest, ['createdAt', 'updatedAt', 'saleStartDate', 'saleEndDate']),
		id: normalizeRecordId(_id),
		storefrontId: DEFAULT_STOREFRONT_ID,
		...(publicCode ? { publicCode, slug: slug ?? slugFor(rest.name, publicCode) } : drawCodeAndSlug(rest.name)),
		...(dimensions && present({ dimensionLength: dimensions.length, dimensionWidth: dimensions.width, dimensionHeight: dimensions.height }))
	};
}

function comboRows(combo) {
	const { _id, __v, categoryRequirements = [], publicCode, slug, ...rest } = combo;
	const id = normalizeRecordId(_id);
	return {
		link: { comboId: id, storefrontId: DEFAULT_STOREFRONT_ID },
		combo: {
			...cleaned(rest, ['createdAt', 'updatedAt']),
			id,
			...(publicCode ? { publicCode, slug: slug ?? slugFor(rest.name, publicCode) } : drawCodeAndSlug(rest.name))
		},
		requirements: categoryRequirements.map((requirement, position) => ({
			...present({ id: idOrUndefined(requirement._id) }), comboId: id, position, category: requirement.category, quantity: requirement.quantity
		}))
	};
}

function orderRows(order) {
	const { _id, __v, items = [], statusHistory = [], internalNotes = [], itemsHistory = [], comboInfo, createdBy, phoneNumber, ...rest } = order;
	const id = normalizeRecordId(_id);
	return {
		order: {
			...cleaned(rest, ['createdAt', 'updatedAt', 'statusUpdatedAt']),
			id,
			// An empty phone is not a phone: the column's CHECK refuses '' where Mongo stored it.
			...(phoneNumber ? { phoneNumber } : {}),
			...(createdBy ? { createdBy: normalizeRecordId(createdBy) } : {}),
			...(comboInfo ? { comboInfo: mapJsonIds(comboInfo) } : {}),
			// Always set here: nothing the file carries may name a storefront.
			storefrontId: rest.isDirectSale === true ? null : DEFAULT_STOREFRONT_ID
		},
		items: items.map((item, position) => ({
			...present({ ...item, _id: undefined, productId: undefined, comboId: undefined }),
			...present({ id: idOrUndefined(item._id), comboId: idOrUndefined(item.comboId) }),
			productId: normalizeRecordId(item.productId),
			orderId: id,
			position
		})),
		statusHistory: statusHistory.map((entry, position) => ({
			...cleaned({ ...entry, _id: undefined }, ['updatedAt']),
			...present({ id: idOrUndefined(entry._id) }),
			orderId: id,
			position
		})),
		internalNotes: internalNotes.map((note, position) => ({ ...cleaned(note, ['at']), orderId: id, position })),
		itemsEdits: itemsHistory.map((edit, position) => ({
			...cleaned(edit, ['editedAt']),
			previousItems: mapJsonIds(edit.previousItems ?? []),
			...(edit.previousComboInfo ? { previousComboInfo: mapJsonIds(edit.previousComboInfo) } : {}),
			orderId: id,
			position
		}))
	};
}

function movementRow(movement, seq) {
	const { _id, __v, productId, orderId, idempotencyKey, ...rest } = movement;
	return {
		...cleaned(rest, ['createdAt', 'appliedAt', 'claimedAt']),
		id: normalizeRecordId(_id),
		productId: normalizeRecordId(productId),
		...(orderId ? { orderId: normalizeRecordId(orderId) } : {}),
		idempotencyKey: mappedKey(idempotencyKey),
		seq
	};
}

function settingsRow(settings) {
	const { _id, __v, ...rest } = settings;
	return { ...cleaned(rest, ['createdAt', 'updatedAt']), id: normalizeRecordId(_id) };
}

async function insertAll(model, rows) {
	for (let from = 0; from < rows.length; from += INSERT_CHUNK) {
		await model.createMany({ data: rows.slice(from, from + INSERT_CHUNK) });
	}
}

/**
 * The first of `count` consecutive `seq` numbers, reserved by moving the
 * sequence past them. `nextval` then `setval` is not atomic, so the movements
 * table lock taken by `replaceAll` keeps any other insert (and its `nextval`) out
 * in between; the write gate that blocks movement-inserting routes during a restore is the second
 * guard. Together they are why the sequence never moves backwards.
 */
async function reserveSeq(tx, count) {
	if (count === 0) return 1;
	const [{ first }] = await tx.$queryRaw`
		SELECT setval(s.name::regclass, nextval(s.name::regclass) + ${count}::bigint - 1) - ${count}::bigint + 1 AS first
		FROM (SELECT pg_get_serial_sequence('stock_movements', 'seq') AS name) AS s`;
	return Number(first);
}

/**
 * Replace every business row with the snapshot's, inside `tx`: all current
 * products, combos, orders, stock movements and settings are deleted first. The
 * caller checks the product stock caches against the restored ledger
 * (`reconcile`) before the transaction commits.
 *
 * @param {Record<string, Array<object>>} snapshot validated wire-form sections
 * @param {object} tx from `withTransaction`
 * @returns {Promise<Record<string, number>>} rows written per section
 * @throws {DuplicateKeyError} the file repeats a unique value (a public code, an SKU, an order code)
 */
function replaceAll(snapshot, tx) {
	return translating(async () => {
		if (!tx) return withTransaction((own) => replaceAll(snapshot, own), WHOLE_STORE_TX);

		// Every row is built before anything is deleted: an id that cannot be mapped fails here.
		const products = snapshot.products.map(productRow);
		const combos = snapshot.combos.map(comboRows);
		const orders = snapshot.orders.map(orderRows);
		const settings = snapshot.settings.map(settingsRow);

		// Taken before the first delete: asking for it after a ROW EXCLUSIVE lock is held
		// could deadlock with a writer that is already inside.
		await tx.$executeRaw`LOCK TABLE stock_movements IN SHARE ROW EXCLUSIVE MODE`;
		await tx.stockMovement.deleteMany({});
		await tx.order.deleteMany({});
		await tx.combo.deleteMany({});
		await tx.product.deleteMany({});
		await tx.settings.deleteMany({});

		await insertAll(tx.product, products);
		await insertAll(tx.combo, combos.map((entry) => entry.combo));
		await insertAll(tx.comboCategoryRequirement, combos.flatMap((entry) => entry.requirements));
		await insertAll(tx.comboStorefront, combos.map((entry) => entry.link));
		await insertAll(tx.order, orders.map((entry) => entry.order));
		await insertAll(tx.orderItem, orders.flatMap((entry) => entry.items));
		await insertAll(tx.orderStatusEntry, orders.flatMap((entry) => entry.statusHistory));
		await insertAll(tx.orderInternalNote, orders.flatMap((entry) => entry.internalNotes));
		await insertAll(tx.orderItemsEdit, orders.flatMap((entry) => entry.itemsEdits));

		const firstSeq = await reserveSeq(tx, snapshot.stockMovements.length);
		await insertAll(tx.stockMovement, snapshot.stockMovements.map((movement, index) => movementRow(movement, firstSeq + index)));
		await insertAll(tx.settings, settings);

		return {
			products: products.length,
			combos: combos.length,
			orders: orders.length,
			stockMovements: snapshot.stockMovements.length,
			settings: settings.length
		};
	});
}

module.exports = { exportAll, countRows, replaceAll, WHOLE_STORE_TX };
