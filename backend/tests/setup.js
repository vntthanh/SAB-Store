/**
 * Per-suite database wiring.
 *
 * The servers themselves start once in tests/global-setup.js. This gives the
 * file its own PostgreSQL database cloned from the run's template, connects
 * mongoose only when the run exercises the mongo backend, and keeps state from
 * leaking between tests.
 *
 * On the mongo backend the URI comes from MONGODB_URI (built in tests/env.js)
 * rather than being assembled here, so mongoose and better-auth's own
 * MongoClient share one database instead of silently using two.
 */
const mongoose = require('mongoose');
const { Client } = require('pg');
const { closeTestServers } = require('./helpers/servers');
const postgres = require('./helpers/postgres');

const USES_MONGO = process.env.DATA_BACKEND === 'mongo';

// PostgreSQL side: this file's own database (PG_TEST_DB, named in env.js), cloned
// from the run's template; one connection to it empties the tables between tests.
let pgCleaner = null;

beforeAll(async () => {
	if (!process.env.PG_TEST_DB) return;
	await postgres.createDatabaseFromTemplate(process.env.PG_TEST_URI, process.env.PG_TEST_DB);
	pgCleaner = new Client({ connectionString: process.env.DATABASE_URL, options: postgres.POOL_OPTIONS });
	await pgCleaner.connect();
});

afterEach(async () => {
	if (pgCleaner) await postgres.truncateAll(pgCleaner);
});

afterAll(async () => {
	if (!pgCleaner) return;
	await pgCleaner.end();
	pgCleaner = null;
	await postgres.dropDatabase(process.env.PG_TEST_URI, process.env.PG_TEST_DB);
});

beforeAll(async () => {
	if (!USES_MONGO) return;
	if (!process.env.MONGO_TEST_URI) {
		throw new Error('MONGO_TEST_URI is not set — tests/global-setup.js did not run');
	}

	await mongoose.connect(process.env.MONGODB_URI);

	// Every test file gets a fresh database, and mongoose builds indexes in the
	// background after connecting. A test that relies on a unique index (a
	// duplicate orderCode, a colliding public code) would otherwise race it and
	// silently insert the duplicate.
	await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
});

// Clear every collection between tests so ordering never leaks state.
afterEach(async () => {
	if (!USES_MONGO) return;
	const { collections } = mongoose.connection;
	await Promise.all(
		Object.values(collections).map((collection) => collection.deleteMany({}))
	);
});

afterAll(async () => {
	await closeTestServers();
	if (USES_MONGO) await mongoose.disconnect();

	// better-auth opens its own connection at require time (a MongoClient apart
	// from mongoose's, or the Prisma pool). Leaving it open keeps a live handle and
	// the run never exits.
	const { closeAuth } = require('../lib/auth');
	await closeAuth();
});
