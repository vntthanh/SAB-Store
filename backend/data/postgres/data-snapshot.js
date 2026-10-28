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
 * moved to Postgres (`normalizeRecordId`): row ids, the ids a row points at, the
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
 * Storefronts travel with the file: the storefronts, their access rules, the email
 * lists with their addresses, `storefrontId` on products and orders and
 * `storefrontIds` (the links) on combos. The lists are customer addresses, not
 * credentials, and the export is admin-only. A restore replaces every storefront.
 * A file made before storefronts existed has none of it; the restore then recreates
 * the default storefront (the constant of data/default-storefront.js) and puts every
 * product, every combo and every online order in it. Direct sales never get one.
 *
 * Variants travel inside their product row (`images`, `options`, `variants`). A
 * file made before variants existed has none: the restore gives every product one
 * default variant holding its stock and points the product's order lines and
 * movements at it, as the migration that introduced variants did.
 *
 * An export from here holds uuid ids.
 */
const { prisma } = require('../../lib/prisma');
const { normalizeRecordId } = require('../ids');
const { DEFAULT_STOREFRONT_ID, DEFAULT_STOREFRONT_SLUG, DEFAULT_STOREFRONT_NAME } = require('../default-storefront');
const { translating } = require('./errors');
const { withSnapshotTransaction, withTransaction } = require('./tx');
const { toRecord: productRecord, FULL_INCLUDE: PRODUCT_INCLUDE, FALLBACK_IMAGE } = require('./products');
const { toRecord: comboRecord, STOREFRONT_SELECT } = require('./combos');
const { toRecord: settingsRecord } = require('./settings');
const { includeFor, toRecord: orderRecord } = require('./order-records');
const { drawCodeAndSlug, slugFor } = require('./public-code');
const { v7: uuidv7 } = require('uuid');
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

/** A row of one of the storefront tables as a wire record: `_id` for the id, an unset column is an absent key. */
function wireRow(row) {
	const { id, ...rest } = row;
	return { _id: id, ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== null)) };
}

/** A product as a wire record: its variants without the fields computed from the product (`label`, `effectivePrice`). */
function productWire(row) {
	const record = productRecord(row);
	record.variants = record.variants.map(({ label: _label, effectivePrice: _price, ...variant }) => variant);
	return record;
}

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
		const [products, combos, orders, movements, settings, storefronts, rules, lists, entries] = [
			await tx.product.findMany({ orderBy: { id: 'asc' }, include: PRODUCT_INCLUDE }),
			await tx.combo.findMany({
				orderBy: { id: 'asc' },
				include: { requirements: { orderBy: { position: 'asc' } }, storefronts: STOREFRONT_SELECT }
			}),
			await tx.order.findMany({ orderBy: { id: 'asc' }, include: includeFor() }),
			await tx.stockMovement.findMany({ orderBy: { seq: 'asc' } }),
			await tx.settings.findMany({ orderBy: { id: 'asc' } }),
			await tx.storefront.findMany({ orderBy: { id: 'asc' } }),
			await tx.storefrontAccessRule.findMany({ orderBy: { id: 'asc' } }),
			await tx.emailList.findMany({ orderBy: { id: 'asc' } }),
			await tx.emailListEntry.findMany({ orderBy: { id: 'asc' } })
		];
		return {
			products: products.map((row) => toWire(productWire(row))),
			combos: combos.map((row) => toWire(comboRecord(row))),
			orders: orders.map((row) => toWire(orderRecord(row))),
			stockMovements: movements.map((row) => toWire(movementWire(row))),
			settings: settings.map((row) => toWire(settingsRecord(row, { defaults: false }))),
			storefronts: storefronts.map((row) => toWire(wireRow(row))),
			storefrontAccessRules: rules.map((row) => toWire(wireRow(row))),
			emailLists: lists.map((row) => toWire(wireRow(row))),
			emailListEntries: entries.map((row) => toWire(wireRow(row)))
		};
	};
	return outer ? read(outer) : withSnapshotTransaction(read);
}

/**
 * How many rows each table holds, the login tables included: a count carries no
 * personal data or credential, unlike a row, which a snapshot never contains for
 * those two.
 *
 * @returns {Promise<{users: number, products: number, orders: number, accounts: number, combos: number, storefronts: number, emailLists: number}>}
 */
async function countRows() {
	const [users, products, orders, accounts, combos, storefronts, emailLists] = await Promise.all([
		prisma.user.count(),
		prisma.product.count(),
		prisma.order.count(),
		prisma.account.count(),
		prisma.combo.count(),
		prisma.storefront.count(),
		prisma.emailList.count()
	]);
	return { users, products, orders, accounts, combos, storefronts, emailLists };
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
const idOrNull = (value) => (value === null || value === undefined ? null : normalizeRecordId(value));

/** The segments of an idempotency key that are legacy ids, mapped; every other segment is kept. */
function mappedKey(key) {
	return key.split(':').map((part) => (HEX_ID.test(part) ? normalizeRecordId(part) : part)).join(':');
}

/** The storefront a row of the file belongs to: a file from before storefronts has none, so everything is the default one. */
const storefrontOf = (value, legacy) => (legacy || value === null || value === undefined ? DEFAULT_STOREFRONT_ID : normalizeRecordId(value));

/**
 * A product's rows: the product, its options and its variants. A product from a
 * file without variants gets its default variant (a new id) holding its stock,
 * and its gallery is its one image, as the cover rule needs.
 */
function productRows(product, legacy) {
	const { _id, __v, dimensions, publicCode, slug, storefrontId, images, options, variants, ...rest } = product;
	const id = normalizeRecordId(_id);
	const imageUrl = rest.imageUrl || FALLBACK_IMAGE;
	const fileVariants = Array.isArray(variants)
		? variants
		: [{ _id: uuidv7(), optionValues: [], stockQuantity: Number.isSafeInteger(rest.stockQuantity) ? rest.stockQuantity : 0 }];
	return {
		product: productRow({ ...rest, imageUrl, images: Array.isArray(images) ? images : imageUrl === FALLBACK_IMAGE ? [] : [imageUrl] }, { _id, dimensions, publicCode, slug, storefrontId }, legacy),
		options: (options ?? []).map((option, position) => ({ productId: id, position, name: option.name, values: option.values })),
		variants: fileVariants.map((variant, position) => ({
			...cleaned({ ...variant, _id: undefined }, ['archivedAt']),
			id: normalizeRecordId(variant._id),
			productId: id,
			position
		}))
	};
}

function productRow(rest, { _id, dimensions, publicCode, slug, storefrontId }, legacy) {
	return {
		...cleaned(rest, ['createdAt', 'updatedAt', 'saleStartDate', 'saleEndDate']),
		id: normalizeRecordId(_id),
		storefrontId: storefrontOf(storefrontId, legacy),
		...(publicCode ? { publicCode, slug: slug ?? slugFor(rest.name, publicCode) } : drawCodeAndSlug(rest.name)),
		...(dimensions && present({ dimensionLength: dimensions.length, dimensionWidth: dimensions.width, dimensionHeight: dimensions.height }))
	};
}

function comboRows(combo, legacy) {
	const { _id, __v, categoryRequirements = [], publicCode, slug, storefrontIds, ...rest } = combo;
	const id = normalizeRecordId(_id);
	const linked = legacy || !Array.isArray(storefrontIds) || storefrontIds.length === 0 ? [DEFAULT_STOREFRONT_ID] : [...new Set(storefrontIds.map(normalizeRecordId))];
	return {
		links: linked.map((storefrontId) => ({ comboId: id, storefrontId })),
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

/** The variant a line or movement of a file without variants belongs to: its product's default one, when the product is in the file. */
const variantOf = (row, defaultVariants) => idOrUndefined(row.variantId) ?? defaultVariants.get(normalizeRecordId(row.productId));

function orderRows(order, legacy, defaultVariants) {
	const { _id, __v, items = [], statusHistory = [], internalNotes = [], itemsHistory = [], comboInfo, createdBy, phoneNumber, storefrontId, ...rest } = order;
	const id = normalizeRecordId(_id);
	return {
		order: {
			...cleaned(rest, ['createdAt', 'updatedAt', 'statusUpdatedAt']),
			id,
			// An empty phone is not a phone: the column's CHECK refuses '', which old backup files can hold.
			...(phoneNumber ? { phoneNumber } : {}),
			...(createdBy ? { createdBy: normalizeRecordId(createdBy) } : {}),
			...(comboInfo ? { comboInfo: mapJsonIds(comboInfo) } : {}),
			// A file from before storefronts puts every online order in the default one; a newer file is taken as it is.
			storefrontId: legacy ? (rest.isDirectSale === true ? null : DEFAULT_STOREFRONT_ID) : idOrNull(storefrontId)
		},
		items: items.map((item, position) => ({
			...present({ ...item, _id: undefined, productId: undefined, comboId: undefined, variantId: undefined }),
			...present({ id: idOrUndefined(item._id), comboId: idOrUndefined(item.comboId), variantId: variantOf(item, defaultVariants) }),
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

function movementRow(movement, seq, defaultVariants) {
	const { _id, __v, productId, variantId: _variantId, orderId, idempotencyKey, ...rest } = movement;
	return {
		...cleaned(rest, ['createdAt', 'appliedAt', 'claimedAt']),
		id: normalizeRecordId(_id),
		productId: normalizeRecordId(productId),
		// A movement of a product the file does not hold has no variant to name; a
		// fresh id keeps the column NOT NULL and the ledger settles it as gone.
		variantId: variantOf(movement, defaultVariants) ?? uuidv7(),
		...(orderId ? { orderId: normalizeRecordId(orderId) } : {}),
		idempotencyKey: mappedKey(idempotencyKey),
		seq
	};
}

function settingsRow(settings) {
	const { _id, __v, ...rest } = settings;
	return { ...cleaned(rest, ['createdAt', 'updatedAt']), id: normalizeRecordId(_id) };
}

function storefrontRow(storefront) {
	const { _id, __v, ...rest } = storefront;
	return { ...cleaned(rest, ['createdAt', 'updatedAt']), id: normalizeRecordId(_id) };
}

function accessRuleRow(rule) {
	const { _id, storefrontId, emailListId, createdBy, ...rest } = rule;
	return {
		...cleaned(rest, ['createdAt']),
		id: normalizeRecordId(_id),
		storefrontId: normalizeRecordId(storefrontId),
		...(emailListId ? { emailListId: normalizeRecordId(emailListId) } : {}),
		...(createdBy ? { createdBy: normalizeRecordId(createdBy) } : {})
	};
}

function emailListRow(list) {
	const { _id, __v, ...rest } = list;
	return { ...cleaned(rest, ['createdAt', 'updatedAt']), id: normalizeRecordId(_id) };
}

function emailListEntryRow(entry) {
	const { _id, emailListId, ...rest } = entry;
	return { ...cleaned(rest, ['createdAt']), id: normalizeRecordId(_id), emailListId: normalizeRecordId(emailListId) };
}

/** The default storefront, for a file made before storefronts existed. */
const defaultStorefrontRow = () => ({
	id: DEFAULT_STOREFRONT_ID, slug: DEFAULT_STOREFRONT_SLUG, name: DEFAULT_STOREFRONT_NAME, visibility: 'PUBLIC', sortOrder: 0
});

/**
 * The file's storefront rows, with the default one guaranteed. Products, combos
 * and orders fall back to it when a storefront is deleted or a record names none,
 * so a file without it would make that fallback fail on the foreign key. It comes
 * back inactive: it must not appear to customers that the file's admin never
 * offered. Its slug gets a numeric suffix when a file storefront already uses it
 * (first free one, so the same file always restores the same way).
 */
function withDefaultStorefront(rows) {
	if (rows.some((row) => row.id === DEFAULT_STOREFRONT_ID)) return rows;
	const slugs = new Set(rows.map((row) => row.slug));
	let slug = DEFAULT_STOREFRONT_SLUG;
	for (let suffix = 2; slugs.has(slug); suffix += 1) slug = `${DEFAULT_STOREFRONT_SLUG}-${suffix}`;
	const sortOrder = rows.reduce((max, row) => Math.max(max, Number(row.sortOrder) || 0), -1) + 1;
	return [...rows, { ...defaultStorefrontRow(), slug, sortOrder, isActive: false }];
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
 * products, combos, orders, stock movements, settings, storefronts, access rules
 * and email lists are deleted first. A snapshot without the storefront sections
 * (a file from before they existed) gets the default storefront back; a file with
 * them but without the default row gets it as an inactive public storefront. The
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
		const legacy = !Array.isArray(snapshot.storefronts);
		const storefronts = legacy ? [defaultStorefrontRow()] : withDefaultStorefront(snapshot.storefronts.map(storefrontRow));
		const rules = legacy ? [] : snapshot.storefrontAccessRules.map(accessRuleRow);
		const lists = legacy ? [] : snapshot.emailLists.map(emailListRow);
		const entries = legacy ? [] : snapshot.emailListEntries.map(emailListEntryRow);
		const products = snapshot.products.map((product) => productRows(product, legacy));
		// Only a file without variants needs them: every line and movement then names none.
		const variantsLegacy = !snapshot.products.some((product) => Array.isArray(product.variants));
		const defaultVariants = new Map(variantsLegacy ? products.map((entry) => [entry.product.id, entry.variants[0].id]) : []);
		const combos = snapshot.combos.map((combo) => comboRows(combo, legacy));
		const orders = snapshot.orders.map((order) => orderRows(order, legacy, defaultVariants));
		const settings = snapshot.settings.map(settingsRow);

		// Taken before the first delete: asking for it after a ROW EXCLUSIVE lock is held
		// could deadlock with a writer that is already inside.
		await tx.$executeRaw`LOCK TABLE stock_movements IN SHARE ROW EXCLUSIVE MODE`;
		await tx.stockMovement.deleteMany({});
		await tx.order.deleteMany({});
		await tx.comboStorefront.deleteMany({});
		await tx.combo.deleteMany({});
		await tx.product.deleteMany({});
		await tx.settings.deleteMany({});
		await tx.storefrontAccessRule.deleteMany({});
		await tx.emailListEntry.deleteMany({});
		await tx.emailList.deleteMany({});
		await tx.storefront.deleteMany({});

		await insertAll(tx.storefront, storefronts);
		await insertAll(tx.emailList, lists);
		await insertAll(tx.emailListEntry, entries);
		await insertAll(tx.storefrontAccessRule, rules);
		await insertAll(tx.product, products.map((entry) => entry.product));
		await insertAll(tx.productOption, products.flatMap((entry) => entry.options));
		await insertAll(tx.productVariant, products.flatMap((entry) => entry.variants));
		await insertAll(tx.combo, combos.map((entry) => entry.combo));
		await insertAll(tx.comboCategoryRequirement, combos.flatMap((entry) => entry.requirements));
		await insertAll(tx.comboStorefront, combos.flatMap((entry) => entry.links));
		await insertAll(tx.order, orders.map((entry) => entry.order));
		await insertAll(tx.orderItem, orders.flatMap((entry) => entry.items));
		await insertAll(tx.orderStatusEntry, orders.flatMap((entry) => entry.statusHistory));
		await insertAll(tx.orderInternalNote, orders.flatMap((entry) => entry.internalNotes));
		await insertAll(tx.orderItemsEdit, orders.flatMap((entry) => entry.itemsEdits));

		const firstSeq = await reserveSeq(tx, snapshot.stockMovements.length);
		await insertAll(tx.stockMovement, snapshot.stockMovements.map((movement, index) => movementRow(movement, firstSeq + index, defaultVariants)));
		await insertAll(tx.settings, settings);

		return {
			products: products.length,
			combos: combos.length,
			orders: orders.length,
			stockMovements: snapshot.stockMovements.length,
			settings: settings.length,
			storefronts: storefronts.length,
			storefrontAccessRules: rules.length,
			emailLists: lists.length,
			emailListEntries: entries.length
		};
	});
}

module.exports = { exportAll, countRows, replaceAll, WHOLE_STORE_TX };
