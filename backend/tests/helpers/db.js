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
 * Portability: `failNextMovementInsert` and `failNextStockWrite` are the one
 * seam that is not portable. They spy on the model the production code calls,
 * so they must be reimplemented at the repository boundary when the store
 * changes. Their handle reports whether the fault fired; a test that uses one
 * must assert that, or a change in how production writes would make its
 * rollback check pass without exercising anything.
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

async function findOne(Model, query) {
	return plain(await Model.findOne(query).lean());
}

const findProduct = (id) => findOne(Product, { _id: id });
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
 * Inserts an order exactly as given, bypassing validation, defaults and hooks,
 * to build shapes the application no longer writes (an order from before stock
 * was tracked per order). Values are stored as given, with no casting: pass Date
 * objects for dates and ObjectIds for references. Returns the stored row.
 */
async function insertRawOrder(fields) {
	const now = new Date();
	const { insertedId } = await Order.collection.insertOne({ createdAt: now, updatedAt: now, ...fields });
	return plain(await Order.collection.findOne({ _id: insertedId }));
}

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

/** Handle on an injected fault: `fired()` is true once the code under test hit it; `remove()` restores the real call. */
function faultOn(Model, method, message) {
	const spy = vi.spyOn(Model, method).mockRejectedValueOnce(new Error(message));
	return { fired: () => spy.mock.calls.length > 0, remove: () => spy.mockRestore() };
}

/** Makes the next stock-movement insert fail with `message`, to prove that the writes around it roll back. */
const failNextMovementInsert = (message) => faultOn(StockMovement, 'create', message);

/** Makes the next write of the product stock cache fail with `message`. */
const failNextStockWrite = (message) => faultOn(Product, 'updateOne', message);

module.exports = {
	newId,
	findProduct,
	findOrder,
	findOrderByCode,
	findMovement,
	listOrders,
	movements,
	movementsFor,
	stockOf,
	countRows,
	insertRawOrder,
	patchProduct,
	patchOrder,
	patchMovement,
	unsetOrderField,
	deleteProduct,
	withTransaction,
	txOptions,
	failNextMovementInsert,
	failNextStockWrite,
};
