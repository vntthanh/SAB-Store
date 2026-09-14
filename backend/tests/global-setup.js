/**
 * Start one in-memory MongoDB for the whole run.
 *
 * This deliberately runs in jest's `globalSetup` (the main Node process) rather
 * than in a per-suite hook. mongodb-memory-server drives its own MongoClient to
 * issue rs.initiate(), and inside jest's module sandbox that client's handshake
 * loses its metadata — the server then rejects it with "Missing required
 * sub-document 'driver'" and the set never elects a primary. Starting it out
 * here avoids the sandbox entirely, and one shared server beats booting mongod
 * once per suite.
 *
 * A single-node replica set, not a standalone: a standalone rejects
 * transactions outright, so any future test that opens a session would fail for
 * reasons unrelated to the code under test.
 */
const { MongoMemoryReplSet } = require('mongodb-memory-server');

module.exports = async function globalSetup() {
	const replSet = await MongoMemoryReplSet.create({
		replSet: { count: 1, storageEngine: 'wiredTiger' },
	});

	// Handed to the worker processes, which cannot share the object itself.
	process.env.MONGO_TEST_URI = replSet.getUri();

	// Stashed on the global so globalTeardown can stop the same instance.
	globalThis.__MONGO_REPLSET__ = replSet;
};
