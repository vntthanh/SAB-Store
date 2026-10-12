/**
 * Start the database servers for the whole run.
 *
 * PostgreSQL always starts (or the TEST_DATABASE_URL server is used), with the
 * per-file template already built, so a broken start fails the whole run instead
 * of surfacing later as a partial suite. An in-memory MongoDB starts only when
 * the run exercises the rollback store (DATA_BACKEND=mongo).
 *
 * The servers deliberately start in vitest's `globalSetup` (the main Node
 * process) rather than in a per-suite hook. mongodb-memory-server drives its own
 * MongoClient to issue rs.initiate(), and inside a test sandbox that client's
 * handshake can lose its metadata: the server then rejects it with "Missing
 * required sub-document 'driver'" and the set never elects a primary. Starting it
 * out here avoids the sandbox entirely, and one shared server beats booting
 * mongod once per suite.
 *
 * MongoDB is a single-node replica set, not a standalone: a standalone rejects
 * transactions outright, so a test that opens a session would fail for reasons
 * unrelated to the code under test. The rollback store runs the same way.
 */
const { startTestPostgres } = require('./helpers/postgres');

async function startReplicaSet() {
	const { MongoMemoryReplSet } = require('mongodb-memory-server');
	return MongoMemoryReplSet.create({
		replSet: { count: 1, storageEngine: 'wiredTiger' },
	});
}

// `test.env` reaches the workers, not this process, so the backend comes from the
// project's config. A DATA_BACKEND exported in the shell is ignored on purpose:
// the workers get the config's value, so honouring the shell here would start
// databases for a backend the tests do not use.
module.exports = async function globalSetup(project) {
	const usesMongo = project?.config?.env?.DATA_BACKEND === 'mongo';
	const replSet = usesMongo ? await startReplicaSet() : null;

	// Handed to the worker processes, which cannot share the object itself: the
	// forks are spawned after this runs and inherit the main process environment.
	if (replSet) process.env.MONGO_TEST_URI = replSet.getUri();

	// If Postgres fails to start, the replica set must not be left running.
	let postgres;
	try {
		postgres = await startTestPostgres();
	} catch (err) {
		await replSet?.stop();
		throw err;
	}
	process.env.PG_TEST_URI = postgres.uri;
	process.env.PG_TEST_TEMPLATE = postgres.template;

	// Vitest calls the returned function once after the whole run.
	return async function globalTeardown() {
		const stops = [postgres.stop()];
		if (replSet) stops.push(replSet.stop());
		const failed = (await Promise.allSettled(stops)).find((r) => r.status === 'rejected');
		if (failed) throw failed.reason;
	};
};
