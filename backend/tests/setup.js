/**
 * Per-suite database wiring.
 *
 * The server itself is started once in tests/global-setup.js; this only points
 * mongoose at it and keeps state from leaking between tests. Each suite gets
 * its own database name so suites running in parallel workers cannot see each
 * other's documents.
 */
const mongoose = require('mongoose');

beforeAll(async () => {
	const uri = process.env.MONGO_TEST_URI;
	if (!uri) {
		throw new Error('MONGO_TEST_URI is not set — tests/global-setup.js did not run');
	}

	// One database per worker keeps parallel suites isolated.
	const dbName = `test_${process.env.JEST_WORKER_ID || '1'}`;
	await mongoose.connect(uri, { dbName });
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
});
