/**
 * Start one in-memory MongoDB for the whole run.
 *
 * This deliberately runs in vitest's `globalSetup` (the main Node process) rather
 * than in a per-suite hook. mongodb-memory-server drives its own MongoClient to
 * issue rs.initiate(), and inside a test sandbox that client's handshake
 * can lose its metadata — the server then rejects it with "Missing required
 * sub-document 'driver'" and the set never elects a primary. Starting it out
 * here avoids the sandbox entirely, and one shared server beats booting mongod
 * once per suite.
 *
 * A single-node replica set, not a standalone: a standalone rejects
 * transactions outright, so any future test that opens a session would fail for
 * reasons unrelated to the code under test.
 *
 * Production runs a single-node replica set too (rs0), so transactions behave
 * the same here as there.
 */
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { startTestPostgres } = require('./helpers/postgres');

module.exports = async function globalSetup() {
	const replSet = await MongoMemoryReplSet.create({
		replSet: { count: 1, storageEngine: 'wiredTiger' },
	});

	// Handed to the worker processes, which cannot share the object itself: the
	// forks are spawned after this runs and inherit the main process environment.
	process.env.MONGO_TEST_URI = replSet.getUri();

	// PostgreSQL next to Mongo: one real server per run (or the TEST_DATABASE_URL
	// one), with the per-file template already built. Every file gets its own
	// database even before any code uses it, so a broken Postgres start fails the
	// whole run instead of surfacing later as a partial suite. If it fails, the
	// replica set must not be left running.
	let postgres;
	try {
		postgres = await startTestPostgres();
	} catch (err) {
		await replSet.stop();
		throw err;
	}
	process.env.PG_TEST_URI = postgres.uri;
	process.env.PG_TEST_TEMPLATE = postgres.template;

	// Vitest calls the returned function once after the whole run.
	return async function globalTeardown() {
		const results = await Promise.allSettled([replSet.stop(), postgres.stop()]);
		const failed = results.find((r) => r.status === 'rejected');
		if (failed) throw failed.reason;
	};
};
