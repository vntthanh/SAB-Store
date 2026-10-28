/**
 * Environment defaults for tests.
 *
 * Loaded first in vitest `setupFiles`, which run before any test module is imported.
 * That ordering is required: lib/auth.js reads DATABASE_URL and JWT_SECRET at
 * require time and opens its own connection there, so setting these from a
 * beforeAll hook would be too late and better-auth would hold a client pointed at
 * a server that does not exist.
 */

// Each test file runs in its own forked process, so the pid names a database no
// concurrent suite can share. VITEST_POOL_ID is not used: ids are recycled as
// soon as a worker is replaced, while the previous process may still be tearing
// down against the same database.
const workerDb = `test_${process.pid}`;

// setup.js creates the database from the template before any test runs.
if (process.env.PG_TEST_URI) {
	process.env.PG_TEST_DB = workerDb;
	process.env.DATABASE_URL = require('./helpers/postgres').databaseUrl(process.env.PG_TEST_URI, workerDb);
}

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-value-at-least-32-chars-long';
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
// Vitest pre-fills process.env.BASE_URL with Vite's own "/" (the public base
// path), which is not a URL: lib/auth.js would hand it to better-auth, which
// rejects it. Only a real URL set by the caller is kept.
if (!process.env.BASE_URL || process.env.BASE_URL === '/') {
	process.env.BASE_URL = 'http://localhost:5000';
}
