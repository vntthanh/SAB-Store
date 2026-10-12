/**
 * Reads the MongoDB store being migrated: every collection the loader takes,
 * whole, as the driver returns it (ObjectId and Date values intact), oldest id
 * first. The source must be quiet (a restored copy, or production with the
 * backend stopped); nothing here locks it.
 */

// Snapshot section -> Mongo collection.
const STORE_COLLECTIONS = {
	products: 'products',
	combos: 'combos',
	orders: 'orders',
	stockMovements: 'stockmovements',
	settings: 'settings'
};

// Better Auth's collections, named as its Mongo adapter names them.
const AUTH_COLLECTIONS = ['user', 'account', 'session', 'verification', 'jwks'];

/**
 * @param {import('mongodb').Db} db
 * @returns {Promise<{store: Record<string, object[]>, auth: Record<string, object[]>, others: Record<string, number>}>}
 *   `others`: document count of every collection the loader does not take, so a
 *   non-empty one stops the run instead of being left behind unnoticed
 */
async function readSource(db) {
	const read = (name) => db.collection(name).find({}).sort({ _id: 1 }).toArray();

	const store = {};
	for (const [section, name] of Object.entries(STORE_COLLECTIONS)) store[section] = await read(name);
	const auth = {};
	for (const name of AUTH_COLLECTIONS) auth[name] = await read(name);

	const taken = new Set([...Object.values(STORE_COLLECTIONS), ...AUTH_COLLECTIONS]);
	const others = {};
	for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
		if (taken.has(name) || name.startsWith('system.')) continue;
		others[name] = await db.collection(name).countDocuments({});
	}
	return { store, auth, others };
}

module.exports = { readSource };
