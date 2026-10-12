/**
 * The PostgreSQL implementation of tests/helpers/db.js, selected by
 * DATA_BACKEND=postgres. Same function names, same plain shapes: ids are uuid
 * strings, `_id` is the row id, columns come back camelCased, `seq` is dropped.
 *
 * Reads and writes go through a separate `pg` pool with plain SQL, not through
 * the repositories or Prisma models under test. Only the fault seams touch the
 * code under test, and only at the boundary the header of db.js names for them.
 *
 * Helpers the stock-ledger contract does not need yet throw "not implemented
 * for postgres"; each phase that converts a repository fills in its own.
 *
 * Fault seams: see db.js. Here `failNextStockWrite` wraps the transaction client
 * so the first write of a product row inside a transaction rejects after the
 * statements before it ran, which is what the Mongo seam does with `updateOne`.
 */
const { Pool } = require('pg');
const { v7: uuidv7 } = require('uuid');
const data = require('../../data');
const { POOL_OPTIONS } = require('./postgres');
const { prisma } = require('../../lib/prisma');
const { DEFAULT_NOTICES, DEFAULT_CONTACT, NOTICE_MAX_LENGTH } = require('../../constants/settings');

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
const patchMovement = patch('stock_movements');

async function deleteProduct(id) {
	await db().query('DELETE FROM products WHERE id = $1::uuid', [id]);
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
function failNextStockWrite(message) {
	const realTransaction = prisma.$transaction.bind(prisma);
	let thrown = false;
	const guarded = (tx) => new Proxy(tx, {
		get(target, property) {
			const value = Reflect.get(target, property);
			if (property !== 'product') return typeof value === 'function' ? value.bind(target) : value;
			return new Proxy(value, {
				get(model, method) {
					const original = Reflect.get(model, method);
					if (!PRODUCT_WRITES.has(method) || thrown) return typeof original === 'function' ? original.bind(model) : original;
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

/** Makes the repository read of sellable products throw `message` until `remove()` is called. */
const failProductCatalogReads = (message) => handleOf(vi.spyOn(data.products, 'findSellable').mockImplementation(() => {
	throw new Error(message);
}));

module.exports = {
	newId,
	findProduct,
	findProductByName,
	findCombo: notImplemented('findCombo'),
	findComboByName: notImplemented('findComboByName'),
	findOrder: notImplemented('findOrder'),
	findOrderRaw: notImplemented('findOrderRaw'),
	findOrderByCode: notImplemented('findOrderByCode'),
	findMovement,
	findSettings: notImplemented('findSettings'),
	listProducts,
	listCombos: notImplemented('listCombos'),
	listOrders: notImplemented('listOrders'),
	movements,
	movementsFor,
	stockOf,
	countRows,
	insertRawOrder: notImplemented('insertRawOrder'),
	insertRawProduct,
	insertRawCombo: notImplemented('insertRawCombo'),
	insertRawSettings: notImplemented('insertRawSettings'),
	insertRawUser: notImplemented('insertRawUser'),
	findAuthRows: notImplemented('findAuthRows'),
	countAuthRows: notImplemented('countAuthRows'),
	settingsDefaults,
	patchProduct,
	patchOrder: notImplemented('patchOrder'),
	patchCombo: notImplemented('patchCombo'),
	patchMovement,
	unsetOrderField: notImplemented('unsetOrderField'),
	deleteProduct,
	deleteAllRows: notImplemented('deleteAllRows'),
	withTransaction,
	txOptions,
	isRowId,
	databaseName,
	ensureMovementStore,
	failNextMovementInsert,
	failNextOrderBulkInsert: notImplemented('failNextOrderBulkInsert'),
	failNextTransactionStart,
	failNextPendingMovementScan,
	failNextStockWrite,
	failNextOrderInsertAsDuplicateCode: notImplemented('failNextOrderInsertAsDuplicateCode'),
	failNextOrderInsertAsDuplicateOn: notImplemented('failNextOrderInsertAsDuplicateOn'),
	failNextProductInsertAsRetryable: notImplemented('failNextProductInsertAsRetryable'),
	failProductCatalogReads,
};
