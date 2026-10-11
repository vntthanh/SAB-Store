/**
 * Backup and restore of the store's business data as one snapshot (the wire form
 * is described in data/snapshot.js).
 *
 * Rows are written exactly as the file holds them: ids, timestamps, `__v` and
 * every sub-array, with no defaults, setters or hooks. That is what makes a
 * restore faithful, and it is why the file is validated as a whole beforehand
 * (`validateSnapshot`). Writing goes through the raw collection so that
 * Mongoose cannot stamp new timestamps or draw a fresh public code.
 */
const mongoose = require('mongoose');
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');
const Order = require('../../models/Order');
const StockMovement = require('../../models/StockMovement');
const Settings = require('../../models/Settings');
const User = require('../../models/User');
const Account = require('../../models/Account');
const { withTransaction } = require('./tx');

const { ObjectId } = mongoose.Types;

// Keyed by snapshot section, in the order a restore writes them.
const COLLECTIONS = {
	products: Product,
	combos: Combo,
	orders: Order,
	stockMovements: StockMovement,
	settings: Settings
};

/** Ids as hex strings and dates as ISO strings, the way the rows serialise to JSON. */
function toWire(value) {
	if (value === null || value === undefined) return value;
	if (value._bsontype === 'ObjectId') return value.toHexString();
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(toWire);
	if (typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toWire(inner)]));
	}
	return value;
}

/**
 * Every row of the business collections, from one consistent read: a transaction
 * sees a single point in time, so a stock movement applied while the export runs
 * cannot leave the product cache and the ledger disagreeing in the file.
 *
 * @returns {Promise<Record<string, Array<object>>>} section -> wire-form rows, oldest id first
 */
function exportAll() {
	return withTransaction(async (tx) => {
		const data = {};
		for (const [section, Model] of Object.entries(COLLECTIONS)) {
			data[section] = toWire(await Model.find({}).sort({ _id: 1 }).lean().session(tx));
		}
		return data;
	});
}

// Casting leaves out every key whose value is null, but a stored null is data
// (`comboInfo: null` on a plain order, `delta: null` on a pending set_target) and
// the next export must show it again. Puts the nulls of `original` back into `cast`.
function restoreNulls(original, cast) {
	if (Array.isArray(original) && Array.isArray(cast)) {
		original.forEach((item, index) => restoreNulls(item, cast[index]));
		return cast;
	}
	if (original === null || typeof original !== 'object' || cast === null || typeof cast !== 'object') return cast;
	for (const [key, value] of Object.entries(original)) {
		if (key === '__proto__') continue;
		if (value === null) cast[key] = null;
		else if (Object.hasOwn(cast, key)) restoreNulls(value, cast[key]);
	}
	return cast;
}

// Mixed fields (`comboInfo`, the item sets kept in `itemsHistory`) are not cast by
// the schema, so the ids inside them are revived by key. They were ObjectIds when
// the order was written, and `$group` by product id and populate rely on that.
const MIXED_ID_KEYS = new Set(['_id', 'productId', 'comboId', 'orderId']);

function reviveIds(value) {
	if (Array.isArray(value)) return value.map(reviveIds);
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value).map(([key, inner]) => [
		key,
		MIXED_ID_KEYS.has(key) && typeof inner === 'string' && ObjectId.isValid(inner) && inner.length === 24
			? new ObjectId(inner)
			: reviveIds(inner)
	]));
}

function reviveOrder(order) {
	const revived = { ...order };
	if (revived.comboInfo !== undefined) revived.comboInfo = reviveIds(revived.comboInfo);
	if (Array.isArray(revived.itemsHistory)) {
		revived.itemsHistory = revived.itemsHistory.map((entry) => ({
			...entry,
			...(entry.previousItems !== undefined && { previousItems: reviveIds(entry.previousItems) }),
			...(entry.previousComboInfo !== undefined && { previousComboInfo: reviveIds(entry.previousComboInfo) })
		}));
	}
	return revived;
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
		User.countDocuments({}),
		Product.countDocuments({}),
		Order.countDocuments({}),
		Account.countDocuments({}),
		Combo.countDocuments({})
	]);
	return { users, products, orders, accounts, combos };
}

/**
 * Replace every business row with the snapshot's, inside `tx`: all current
 * products, combos, orders, stock movements and settings are deleted first.
 *
 * The product rows carry their stock cache and the movement rows their status
 * and `stockAfter` as the file has them. This is the one bulk write of the cache
 * besides the ledger worker, and it is only sound because the caller checks the
 * cache against the ledger (`reconcile`) before the transaction commits.
 *
 * @param {Record<string, Array<object>>} snapshot validated wire-form sections
 * @param {object} tx from `withTransaction`
 * @returns {Promise<Record<string, number>>} rows written per section
 */
async function replaceAll(snapshot, tx) {
	const session = { session: tx };
	for (const Model of Object.values(COLLECTIONS)) {
		await Model.collection.deleteMany({}, session);
	}

	const written = {};
	for (const [section, Model] of Object.entries(COLLECTIONS)) {
		const rows = snapshot[section].map((row) => {
			const cast = restoreNulls(row, Model.castObject(row));
			return section === 'orders' ? reviveOrder(cast) : cast;
		});
		if (rows.length > 0) await Model.collection.insertMany(rows, { ...session, ordered: true });
		written[section] = rows.length;
	}
	return written;
}

module.exports = { exportAll, countRows, replaceAll };
