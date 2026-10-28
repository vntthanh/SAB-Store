/**
 * Per-suite database wiring.
 *
 * The server itself starts once in tests/global-setup.js. This gives the file
 * its own PostgreSQL database cloned from the run's template and keeps state
 * from leaking between tests.
 */
const { Client } = require('pg');
const { closeTestServers } = require('./helpers/servers');
const postgres = require('./helpers/postgres');

// This file's own database (PG_TEST_DB, named in env.js), cloned from the run's
// template; one connection to it empties the tables between tests.
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

afterAll(async () => {
	await closeTestServers();

	// better-auth opens its own Prisma pool at require time. Leaving it open keeps a
	// live handle and the run never exits.
	const { closeAuth } = require('../lib/auth');
	await closeAuth();
});
