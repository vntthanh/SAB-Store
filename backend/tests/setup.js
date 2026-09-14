/**
 * Per-suite database wiring.
 *
 * The server itself starts once in tests/global-setup.js; this only connects
 * mongoose to it and keeps state from leaking between tests.
 *
 * The URI comes from MONGODB_URI (built in tests/env.js) rather than being
 * assembled here, so mongoose and better-auth's own MongoClient share one
 * database instead of silently using two.
 */
const mongoose = require('mongoose');

beforeAll(async () => {
	const uri = process.env.MONGODB_URI;
	if (!process.env.MONGO_TEST_URI) {
		throw new Error('MONGO_TEST_URI is not set — tests/global-setup.js did not run');
	}

	await mongoose.connect(uri);
});

// Clear every collection between tests so ordering never leaks state.
afterEach(async () => {
	const { collections } = mongoose.connection;
	await Promise.all(
		Object.values(collections).map((collection) => collection.deleteMany({}))
	);
});

afterAll(async () => {
	await mongoose.disconnect();

	// better-auth opens its own MongoClient at require time, separate from
	// mongoose's. Leaving it open keeps a live handle and the run never exits.
	const { client } = require('../lib/auth');
	await client.close();
});
