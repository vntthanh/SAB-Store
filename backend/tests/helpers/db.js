/**
 * Independent inspection and fixture helpers for the store database.
 *
 * Tests assert through these instead of through the models or repositories under
 * test, so the check does not share code with what it checks. The interface is
 * in domain terms: ids go in and come out as hex strings, results are plain
 * objects shaped like the API JSON (`_id` is a string, no `__v`), and filters
 * are field -> value, where an array means "any of". The interface says nothing
 * about how rows are stored (this file does, on Mongoose), so a SQL-backed
 * implementation can replace the file without touching a test.
 *
 * Nothing in this file may call a repository or a service; it reads and writes
 * the database directly.
 *
 * Ordering: "oldest first" means createdAt with _id as a stable tie-break, not
 * insertion order.
 *
 * Portability: most of this file is plain data access. These seams are tied to
 * the store and each needs a deliberate SQL counterpart:
 * - `failNextMovementInsert`, `failNextStockWrite` and
 *   `failNextOrderInsertAsDuplicateCode` spy on the model the production code
 *   calls, so they must be reimplemented at the repository boundary. The
 *   duplicate-code fault throws the Mongo duplicate-key shape (`code` 11000 on
 *   `orderCode`); the SQL version must throw whatever the repository's
 *   duplicate-key translation expects. Their handle reports whether the fault
 *   fired; a test that uses one must assert that, or a change in how
 *   production writes would make its rollback check pass without exercising
 *   anything.
 * - `withTransaction` and `txOptions` hand a service the store's transaction
 *   handle; the SQL version passes its own client in the option the repository
 *   layer defines.
 * - `isRowId` is not trivial on SQL: it states that the pricing service
 *   returns an id normalised to the store's native representation. On SQL it
 *   returns true for a lowercase 24-hex string and false for anything else (an
 *   uppercase hex string or a number, for example).
 * - `ensureMovementStore` exists only because Mongo creates a collection on
 *   first insert; it disappears on SQL.
 */
const mongoose = require('mongoose');
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');
const Order = require('../../models/Order');
const StockMovement = require('../../models/StockMovement');

const KINDS = { product: Product, combo: Combo, order: Order, movement: StockMovement };

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

/** A fresh id nothing refers to, as a hex string. */
const newId = () => new mongoose.Types.ObjectId().toHexString();

/** Deep copy with ObjectIds as hex strings and the storage version key dropped. Dates stay Dates. */
function plain(value) {
	if (value === null || value === undefined) return value;
	if (value._bsontype === 'ObjectId') return value.toHexString();
	if (value instanceof Date) return value;
	if (Array.isArray(value)) return value.map(plain);
	if (typeof value === 'object') {
		const out = {};
		for (const [key, inner] of Object.entries(value)) {
			if (key !== '__v') out[key] = plain(inner);
		}
		return out;
	}
	return value;
}

const toQuery = (filter) =>
	Object.fromEntries(Object.entries(filter).map(([key, value]) => [key, Array.isArray(value) ? { $in: value } : value]));

const byAge = { createdAt: 1, _id: 1 };

async function findOne(Model, query, sort = {}) {
	return plain(await Model.findOne(query).sort(sort).lean());
}

const findProduct = (id) => findOne(Product, { _id: id });
// Name lookups are for callers that use distinct names; the age sort only makes a duplicate deterministic.
const findProductByName = (name) => findOne(Product, { name }, byAge);
const findCombo = (id) => findOne(Combo, { _id: id });
const findComboByName = (name) => findOne(Combo, { name }, byAge);
const findOrder = (id) => findOne(Order, { _id: id });
const findOrderByCode = (orderCode) => findOne(Order, { orderCode });
const findMovement = (id) => findOne(StockMovement, { _id: id });

/** Every order, oldest first. */
async function listOrders() {
	return plain(await Order.find().sort(byAge).lean());
}

/** Movements matching `filter` (e.g. `{ type: 'order_cancel', productId }`), oldest first. */
async function movements(filter = {}) {
	return plain(await StockMovement.find(toQuery(filter)).sort(byAge).lean());
}

const movementsFor = (productId) => movements({ productId });

/** The cached stock of a product, or null when the product does not exist. */
async function stockOf(productId) {
	const product = await Product.findById(productId).select('stockQuantity').lean();
	return product ? product.stockQuantity : null;
}

/** Row count of `kind` ('product' | 'combo' | 'order' | 'movement'), optionally narrowed by `filter`. */
function countRows(kind, filter = {}) {
	const Model = KINDS[kind];
	if (!Model) throw new Error(`countRows: unknown kind "${kind}"`);
	return Model.countDocuments(toQuery(filter));
}

/**
 * Inserts a row exactly as given, bypassing validation, defaults and hooks, to
 * build shapes the application no longer writes (an order from before stock was
 * tracked per order, a product from before it had a sales channel). Values are
 * stored as given, with no casting: pass Date objects for dates and ObjectIds
 * for references. Returns the stored row.
 */
const insertRaw = (Model) => async (fields) => {
	const now = new Date();
	const { insertedId } = await Model.collection.insertOne({ createdAt: now, updatedAt: now, ...fields });
	return plain(await Model.collection.findOne({ _id: insertedId }));
};
const insertRawOrder = insertRaw(Order);
const insertRawProduct = insertRaw(Product);
const insertRawCombo = insertRaw(Combo);

/**
 * Overwrites fields of an existing row without validation, hooks or the
 * immutability of timestamps, to put a row into a state the application's own
 * write paths cannot reach (a hand-edited stock cache, a backdated claim).
 * Values are written as given, with no casting: pass Date objects for dates and
 * the same id form the row already holds.
 */
const update = (Model, id, change) =>
	Model.collection.updateOne({ _id: toObjectId(id) }, change).then(({ matchedCount }) => {
		if (matchedCount !== 1) throw new Error(`no ${Model.modelName} with id ${id}`);
	});
const patch = (Model) => (id, fields) => update(Model, id, { $set: fields });
const patchProduct = patch(Product);
const patchOrder = patch(Order);
const patchCombo = patch(Combo);
const patchMovement = patch(StockMovement);

/** Removes a field from an order, as for an order stored before the field existed. */
const unsetOrderField = (id, field) => update(Order, id, { $unset: { [field]: '' } });

async function deleteProduct(id) {
	await Product.deleteOne({ _id: id });
}

/**
 * Runs `fn(tx)` in a database transaction that the caller can make fail, to
 * observe whether a write made through `txOptions(tx)` rolls back with it.
 * `tx` is opaque: pass it to `txOptions` unchanged and never inspect it.
 */
function withTransaction(fn) {
	return mongoose.connection.transaction(fn);
}

/**
 * The option bag with which a service is told to write inside `tx`. Tests use
 * this instead of spelling the production option name, which will change.
 */
const txOptions = (tx) => ({ session: tx });

/**
 * True when `value` is the store's native id type, as opposed to the hex string
 * that ids take everywhere else in this file. For checking that code under test
 * hands the store an id it can write without casting.
 */
const isRowId = (value) => value instanceof mongoose.Types.ObjectId;

/** Creates the empty movement store up front, so the first movement insert of a test does not race its own creation. */
async function ensureMovementStore() {
	await StockMovement.createCollection();
}

/**
 * Handle on an injected fault: `fired()` is true once the code under test hit
 * it; `calls()` counts every call of the faulted method, injected or not;
 * `remove()` restores the real call.
 */
function handleOf(spy) {
	return { fired: () => spy.mock.calls.length > 0, calls: () => spy.mock.calls.length, remove: () => spy.mockRestore() };
}

function faultOn(Model, method, message) {
	return handleOf(vi.spyOn(Model, method).mockRejectedValueOnce(new Error(message)));
}

/** Makes the next stock-movement insert fail with `message`, to prove that the writes around it roll back. */
const failNextMovementInsert = (message) => faultOn(StockMovement, 'create', message);

/** Makes the next write of the product stock cache fail with `message`. */
const failNextStockWrite = (message) => faultOn(Product, 'updateOne', message);

/**
 * Makes the next order insert fail as a duplicate order code (the race where
 * two requests pick the same fresh code), then lets later inserts through to
 * the real write.
 */
function failNextOrderInsertAsDuplicateCode() {
	let thrown = false;
	const spy = vi.spyOn(Order.prototype, 'save').mockImplementationOnce(async () => {
		thrown = true;
		const error = new Error('E11000 duplicate key error collection: orders index: orderCode_1');
		error.code = 11000;
		throw error;
	});
	return { ...handleOf(spy), fired: () => thrown };
}

module.exports = {
	newId,
	findProduct,
	findProductByName,
	findCombo,
	findComboByName,
	findOrder,
	findOrderByCode,
	findMovement,
	listOrders,
	movements,
	movementsFor,
	stockOf,
	countRows,
	insertRawOrder,
	insertRawProduct,
	insertRawCombo,
	patchProduct,
	patchOrder,
	patchCombo,
	patchMovement,
	unsetOrderField,
	deleteProduct,
	withTransaction,
	txOptions,
	isRowId,
	ensureMovementStore,
	failNextMovementInsert,
	failNextStockWrite,
	failNextOrderInsertAsDuplicateCode,
};
