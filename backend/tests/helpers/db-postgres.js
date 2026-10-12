/**
 * The PostgreSQL implementation of tests/helpers/db.js, selected by
 * DATA_BACKEND=postgres. Same function names, same plain shapes: ids are uuid
 * strings, `_id` is the row id, columns come back camelCased, `seq` is dropped.
 *
 * Reads and writes go through a separate `pg` pool with plain SQL, not through
 * the repositories or Prisma models under test. Only the fault seams touch the
 * code under test, and only at the boundary the header of db.js names for them.
 *
 * Helpers no contract needs yet throw "not implemented for postgres"; each phase
 * that converts a repository fills in its own. `unsetOrderField` can never
 * apply (a column cannot be missing) and throws for good.
 *
 * The login-table helpers (`countRows('user'|'account')`, `insertRawUser`,
 * `findAuthRows`, `countAuthRows`) are not here: login stays on MongoDB until
 * the auth conversion, so db.js keeps serving them from MongoDB.
 *
 * Fault seams: see db.js. Here `failNextStockWrite` wraps the transaction client
 * so the first write of a product row inside a transaction rejects after the
 * statements before it ran, which is what the Mongo seam does with `updateOne`.
 */
const { Pool } = require('pg');
const { v7: uuidv7 } = require('uuid');
const data = require('../../data');
const { DuplicateKeyError } = require('../../data/errors');
const { POOL_OPTIONS } = require('./postgres');
const { prisma } = require('../../lib/prisma');
const { SETTINGS_KEY, DEFAULT_NOTICES, DEFAULT_CONTACT, NOTICE_MAX_LENGTH } = require('../../constants/settings');

const TABLES = { product: 'products', combo: 'combos', order: 'orders', movement: 'stock_movements', settings: 'settings' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let pool = null;
function db() {
	if (!pool) {
		pool = new Pool({ connectionString: process.env.DATABASE_URL, options: POOL_OPTIONS, max: 2, idleTimeoutMillis: 1000, allowExitOnIdle: true });
	}
	return pool;
}

afterAll(async () => {
	if (pool) await pool.end();
	pool = null;
});

const armed = new Set();
afterEach(() => {
	for (const fault of armed) fault.remove();
	armed.clear();
});

const snake = (name) => name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
const camel = (name) => name.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
const quote = (name) => `"${name.replace(/"/g, '""')}"`;
const columnOf = (key) => (key === '_id' ? 'id' : snake(key));

/** A row as the API would show it: `_id`, camelCase keys, no internal `seq`. */
function toPlain(row) {
	if (!row) return null;
	const out = {};
	for (const [key, value] of Object.entries(row)) {
		if (key === 'seq') continue;
		out[key === 'id' ? '_id' : camel(key)] = value;
	}
	return out;
}

function tableOf(kind) {
	const table = TABLES[kind];
	if (!table) throw new Error(`unknown row kind "${kind}"`);
	return table;
}

/** `WHERE` for a field -> value filter; an array means "any of". Everything compares as text, so enums and uuids need no casts. */
function whereOf(filter, values = []) {
	const clauses = Object.entries(filter).map(([key, value]) => {
		const column = `${quote(columnOf(key))}::text`;
		if (Array.isArray(value)) {
			values.push(value.map(String));
			return `${column} = ANY($${values.length}::text[])`;
		}
		if (value === null) return `${quote(columnOf(key))} IS NULL`;
		values.push(String(value));
		return `${column} = $${values.length}`;
	});
	return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

async function select(table, filter = {}, order = 'created_at, id') {
	const values = [];
	const { rows } = await db().query(`SELECT * FROM ${quote(table)} ${whereOf(filter, values)} ORDER BY ${order}`, values);
	return rows.map(toPlain);
}

async function selectOne(table, filter) {
	const rows = await select(table, filter);
	return rows[0] || null;
}

const notImplemented = (name) => () => {
	throw new Error(`${name} is not implemented for postgres`);
};

/** A fresh id nothing refers to. */
const newId = () => uuidv7();

const findProduct = (id) => selectOne('products', { _id: id });
const findProductByName = (name) => selectOne('products', { name });

/** A combo with its requirements, `{ _id, category, quantity }` each, in position order. */
async function withRequirements(combo) {
	if (!combo) return null;
	const { rows } = await db().query('SELECT id, category, quantity FROM combo_category_requirements WHERE combo_id = $1::uuid ORDER BY position', [combo._id]);
	return { ...combo, categoryRequirements: rows.map((row) => ({ _id: row.id, category: row.category, quantity: row.quantity })) };
}
const findCombo = async (id) => withRequirements(await selectOne('combos', { _id: id }));
const findComboByName = async (name) => withRequirements(await selectOne('combos', { name }));
const listCombos = async () => Promise.all((await select('combos')).map(withRequirements));
/** The single settings row, or null when none exists. */
const findSettings = () => selectOne('settings', {});

// An optional order column that is NULL is an absent key in the API JSON.
const ORDER_ABSENT_WHEN_NULL = new Set(['orderNumber', 'phoneNumber', 'studentId', 'fullName', 'email', 'additionalNote', 'transactionCode', 'cancelReason', 'createdBy']);
const dropNulls = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key, value]) => value !== null || !keys.has(key)));

/** An order with its child rows nested the way the API JSON shows them, in position order. */
async function withOrderChildren(order) {
	if (!order) return null;
	const children = async (table) => (await db().query(`SELECT * FROM ${table} WHERE order_id = $1::uuid ORDER BY position`, [order._id])).rows.map(toPlain);
	const [items, history, notes, edits] = await Promise.all([
		children('order_items'), children('order_status_history'), children('order_internal_notes'), children('order_items_edits')
	]);
	const strip = ({ orderId: _orderId, position: _position, ...rest }) => rest;
	return {
		...dropNulls(order, ORDER_ABSENT_WHEN_NULL),
		items: items.map(strip),
		statusHistory: history.map((entry) => dropNulls(strip(entry), new Set(['transactionCode', 'cancelReason', 'note']))),
		internalNotes: notes.map(({ _id: _noteId, ...rest }) => strip(rest)),
		itemsHistory: edits.map(({ _id: _editId, ...rest }) => strip(rest))
	};
}

const findOrder = async (id) => withOrderChildren(await selectOne('orders', { _id: id }));
const findOrderByCode = async (orderCode) => withOrderChildren(await selectOne('orders', { orderCode }));
const listOrders = async () => Promise.all((await select('orders')).map(withOrderChildren));

const findMovement = (id) => selectOne('stock_movements', { _id: id });
const listProducts = () => select('products');

/** Movements matching `filter` (e.g. `{ type: 'order_cancel', productId }`), oldest first (insertion order, which is what `seq` records). */
const movements = (filter = {}) => select('stock_movements', filter, 'seq');
const movementsFor = (productId) => movements({ productId });

/** The cached stock of a product, or null when the product does not exist. */
async function stockOf(productId) {
	const { rows } = await db().query('SELECT stock_quantity FROM products WHERE id = $1::uuid', [productId]);
	return rows.length ? rows[0].stock_quantity : null;
}

/** Row count of `kind`, optionally narrowed by `filter`. */
async function countRows(kind, filter = {}) {
	const values = [];
	const { rows } = await db().query(`SELECT count(*)::int AS n FROM ${quote(tableOf(kind))} ${whereOf(filter, values)}`, values);
	return rows[0].n;
}

// Defaults for the NOT NULL columns without a database default, so a test names only what it cares about.
const PRODUCT_DEFAULTS = () => ({ name: `Test Product ${uuidv7()}`, price: 0, category: 'general', publicCode: uuidv7(), slug: 'test-product' });

/**
 * Inserts a product exactly as given plus defaults for the columns that must
 * exist, bypassing every repository. Returns the stored row.
 */
async function insertRawProduct(fields) {
	const row = { id: uuidv7(), ...PRODUCT_DEFAULTS(), ...fields };
	const columns = Object.keys(row).map(columnOf);
	const { rows } = await db().query(
		`INSERT INTO products (${columns.map(quote).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
		Object.values(row)
	);
	return toPlain(rows[0]);
}

const COMBO_DEFAULTS = () => ({ name: `Test Combo ${uuidv7()}`, price: 0, publicCode: uuidv7(), slug: 'test-combo' });

/**
 * Inserts a combo exactly as given plus defaults for the columns that must exist,
 * and one requirements row per `categoryRequirements` entry.
 */
async function insertRawCombo({ categoryRequirements = [], ...fields }) {
	const row = { id: uuidv7(), ...COMBO_DEFAULTS(), ...fields };
	const columns = Object.keys(row).map(columnOf);
	await db().query(
		`INSERT INTO combos (${columns.map(quote).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
		Object.values(row)
	);
	// Written last position first, so a read without ORDER BY position comes back in the wrong order.
	for (const [position, requirement] of [...categoryRequirements.entries()].reverse()) {
		await db().query(
			'INSERT INTO combo_category_requirements (id, combo_id, position, category, quantity) VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
			[uuidv7(), row.id, position, requirement.category, requirement.quantity]
		);
	}
	return findCombo(row.id);
}

/**
 * Inserts the single settings row exactly as given: the key defaults to the one
 * the application reads, a column left out is NULL (or its database default).
 * The two bank columns are NOT NULL, so a caller names them.
 */
async function insertRawSettings(fields) {
	const row = { id: uuidv7(), key: SETTINGS_KEY, ...fields };
	const columns = Object.keys(row).map(columnOf);
	const { rows } = await db().query(
		`INSERT INTO settings (${columns.map(quote).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
		Object.values(row)
	);
	return toPlain(rows[0]);
}

const json = (value) => JSON.stringify(value);

/**
 * Inserts an order exactly as given (no rules, no hooks) plus the two columns it
 * cannot exist without, and one child row per `items`, `statusHistory`,
 * `internalNotes` and `itemsHistory` entry, in array order. Returns the stored order.
 */
async function insertRawOrder({ items = [], statusHistory = [], internalNotes = [], itemsHistory = [], comboInfo, ...fields }) {
	const row = { id: uuidv7(), orderCode: `W${Math.floor(Math.random() * 1e8)}`, totalAmount: 0, ...fields };
	const columns = Object.keys(row).map(columnOf);
	const values = Object.values(row);
	if (comboInfo !== undefined && comboInfo !== null) {
		columns.push('combo_info');
		values.push(json(comboInfo));
	}
	await db().query(`INSERT INTO orders (${columns.map(quote).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, values);

	const insertChild = async (table, rows, shape) => {
		// Written last position first, so a read without ORDER BY position comes back in the wrong order.
		for (const [position, entry] of [...rows.entries()].reverse()) {
			const child = { id: uuidv7(), orderId: row.id, position, ...shape(entry) };
			const childColumns = Object.keys(child).filter((key) => child[key] !== undefined).map(columnOf);
			await db().query(
				`INSERT INTO ${table} (${childColumns.map(quote).join(', ')}) VALUES (${childColumns.map((_, i) => `$${i + 1}`).join(', ')})`,
				Object.values(child).filter((value) => value !== undefined)
			);
		}
	};
	await insertChild('order_items', items, ({ _id, ...item }) => ({ ...(_id && { id: _id }), ...item }));
	await insertChild('order_status_history', statusHistory, ({ _id, ...entry }) => ({ ...(_id && { id: _id }), ...entry }));
	await insertChild('order_internal_notes', internalNotes, (note) => note);
	await insertChild('order_items_edits', itemsHistory, (edit) => ({
		...edit, previousItems: json(edit.previousItems ?? []), previousComboInfo: edit.previousComboInfo == null ? undefined : json(edit.previousComboInfo)
	}));
	return findOrder(row.id);
}

/**
 * Overwrites columns of an existing row without validation or hooks, to put a
 * row into a state the application's own write paths cannot reach.
 */
const patch = (table) => async (id, fields) => {
	const entries = Object.entries(fields);
	const sets = entries.map(([key], i) => `${quote(columnOf(key))} = $${i + 1}`).join(', ');
	const { rowCount } = await db().query(`UPDATE ${quote(table)} SET ${sets} WHERE id = $${entries.length + 1}::uuid`, [...entries.map(([, v]) => v), id]);
	if (rowCount !== 1) throw new Error(`no ${table} row with id ${id}`);
};
const patchProduct = patch('products');
/** Scalar order columns only; the child tables are written by `insertRawOrder`. */
const patchOrder = patch('orders');
const patchCombo = patch('combos');
const patchMovement = patch('stock_movements');

async function deleteProduct(id) {
	await db().query('DELETE FROM products WHERE id = $1::uuid', [id]);
}

// Never the ledger: emptying movements would leave cached stock that no row explains.
const DELETABLE_KINDS = new Set(['product', 'combo', 'order', 'settings']);

/** Empties every table of the given kinds (`'product'`, `'combo'`, `'order'`, `'settings'`); child rows go with their parent. */
async function deleteAllRows(...kinds) {
	for (const kind of kinds) {
		if (!DELETABLE_KINDS.has(kind)) throw new Error(`deleteAllRows: ${kind} cannot be emptied`);
	}
	for (const kind of kinds) await db().query(`DELETE FROM ${quote(tableOf(kind))}`);
}

/**
 * Runs `fn(tx)` in a database transaction that the caller can make fail. `tx`
 * is opaque: pass it to `txOptions` unchanged.
 */
const withTransaction = (fn) => prisma.$transaction(fn);

/** The option with which a service is told to write inside `tx`. */
const txOptions = (tx) => ({ tx });

/** True for a lowercase uuid string, the id form the repositories hand to pricing. */
const isRowId = (value) => typeof value === 'string' && UUID.test(value);

/** The name of the database the application is connected to. */
const databaseName = () => decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1));

/** Nothing to create up front: the table comes with the migrations. */
async function ensureMovementStore() {}

const settingsDefaults = { notices: DEFAULT_NOTICES, contact: DEFAULT_CONTACT, noticeMaxLength: NOTICE_MAX_LENGTH };

/**
 * Handle on an injected fault: `fired()` is true once the code under test hit
 * it; `calls()` counts every call of the faulted method; `remove()` restores
 * the real call.
 */
function handleOf(spy, fired = () => spy.mock.calls.length > 0) {
	const handle = { fired, calls: () => spy.mock.calls.length, remove: () => { spy.mockRestore(); armed.delete(handle); } };
	armed.add(handle);
	return handle;
}

/** Makes the next stock-movement insert fail with `message`, to prove that the writes around it roll back. */
const failNextMovementInsert = (message) => handleOf(vi.spyOn(data.stockLedger, 'createMovement').mockRejectedValueOnce(new Error(message)));

/** Makes the next attempt to open a database transaction reject with `message`. */
const failNextTransactionStart = (message) => handleOf(vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error(message)));

/** Makes the next read of pending stock movements throw `message`, synchronously, as the sweeper's re-enqueue scan does. */
const failNextPendingMovementScan = (message) => handleOf(vi.spyOn(data.stockLedger, 'listPendingIdsCreatedBefore').mockImplementationOnce(() => {
	throw new Error(message);
}));

const PRODUCT_WRITES = new Set(['update', 'updateMany', 'upsert']);

/**
 * Makes the first write of a product row made inside a transaction reject with
 * `message`, after the statements before it ran, so the transaction has to roll
 * the earlier ones back.
 */
const failNextStockWrite = (message) => failFirstWriteOf('product', PRODUCT_WRITES, message);

/**
 * Makes the next order insert fail as a duplicate on `column`, then lets later
 * inserts through. Raised at the repository boundary with the domain error the
 * duplicate-key translation produces, so the callers' retry loops see what a real
 * unique violation gives them.
 */
function failNextOrderInsertAsDuplicateOn(column) {
	let thrown = false;
	const spy = vi.spyOn(data.orders, 'create').mockImplementationOnce(async () => {
		thrown = true;
		throw new DuplicateKeyError([column]);
	});
	return handleOf(spy, () => thrown);
}

/** Makes the next product insert write its row and then fail with the retryable-transaction error, so the attempt is rerun from the start. */
function failNextProductInsertAsRetryable() {
	const realCreate = data.products.create;
	let thrown = false;
	const spy = vi.spyOn(data.products, 'create').mockImplementationOnce(async (...args) => {
		await realCreate(...args);
		thrown = true;
		throw Object.assign(new Error('transient'), { code: 'P2034' });
	});
	return handleOf(spy, () => thrown);
}

/**
 * Makes the first write of `model` (a Prisma delegate name) made inside a
 * transaction reject with `message`, after the statements before it ran.
 */
function failFirstWriteOf(model, methods, message) {
	const realTransaction = prisma.$transaction.bind(prisma);
	let thrown = false;
	const guarded = (tx) => new Proxy(tx, {
		get(target, property) {
			const value = Reflect.get(target, property);
			if (property !== model) return typeof value === 'function' ? value.bind(target) : value;
			return new Proxy(value, {
				get(delegate, method) {
					const original = Reflect.get(delegate, method);
					if (!methods.has(method) || thrown) return typeof original === 'function' ? original.bind(delegate) : original;
					return async () => {
						thrown = true;
						throw new Error(message);
					};
				}
			});
		}
	});
	const spy = vi.spyOn(prisma, '$transaction').mockImplementation((arg, ...rest) =>
		(typeof arg === 'function' ? realTransaction((tx) => arg(guarded(tx)), ...rest) : realTransaction(arg, ...rest)));
	return handleOf(spy, () => thrown);
}

/** Makes the next bulk write of orders fail with `message`, as a restore does after it has deleted the old rows and written products and combos. */
const failNextOrderBulkInsert = (message) => failFirstWriteOf('order', new Set(['createMany']), message);

/** Makes the repository read of sellable products throw `message` until `remove()` is called. */
const failProductCatalogReads = (message) => handleOf(vi.spyOn(data.products, 'findSellable').mockImplementation(() => {
	throw new Error(message);
}));

module.exports = {
	newId,
	findProduct,
	findProductByName,
	findCombo,
	findComboByName,
	findOrder,
	// Ids are uuid strings in every form, so the raw read is the plain one.
	findOrderRaw: findOrder,
	findOrderByCode,
	findMovement,
	findSettings,
	listProducts,
	listCombos,
	listOrders,
	movements,
	movementsFor,
	stockOf,
	countRows,
	insertRawOrder,
	insertRawProduct,
	insertRawCombo,
	insertRawSettings,
	insertRawUser: notImplemented('insertRawUser'),
	findAuthRows: notImplemented('findAuthRows'),
	countAuthRows: notImplemented('countAuthRows'),
	settingsDefaults,
	patchProduct,
	patchOrder,
	patchCombo,
	patchMovement,
	unsetOrderField: notImplemented('unsetOrderField'),
	deleteProduct,
	deleteAllRows,
	withTransaction,
	txOptions,
	isRowId,
	databaseName,
	ensureMovementStore,
	failNextMovementInsert,
	failNextOrderBulkInsert,
	failNextTransactionStart,
	failNextPendingMovementScan,
	failNextStockWrite,
	failNextOrderInsertAsDuplicateCode: () => failNextOrderInsertAsDuplicateOn('orderCode'),
	failNextOrderInsertAsDuplicateOn,
	failNextProductInsertAsRetryable,
	failProductCatalogReads,
};
