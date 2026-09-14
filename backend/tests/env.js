/**
 * Environment defaults for tests.
 *
 * Loaded via jest `setupFiles`, which runs before any test module is imported.
 * That ordering is required: lib/auth.js reads MONGODB_URI and JWT_SECRET at
 * require time and opens its own MongoClient there, so setting these from a
 * beforeAll hook would be too late and better-auth would hold a client pointed
 * at a server that does not exist.
 *
 * MONGODB_URI therefore has to be the real in-memory server, not a placeholder:
 * mongoose and better-auth each open their own connection from it and must land
 * in the SAME database, or an account written through one is invisible to the
 * other.
 */

// Each worker gets its own database so suites running in parallel cannot see
// each other's documents.
const workerDb = `test_${process.env.JEST_WORKER_ID || '1'}`;

if (process.env.MONGO_TEST_URI) {
	// getUri() yields mongodb://host:port/?replicaSet=... — set the path without
	// disturbing the query string that selects the replica set.
	const uri = new URL(process.env.MONGO_TEST_URI);
	uri.pathname = `/${workerDb}`;
	process.env.MONGODB_URI = uri.toString();
} else if (!process.env.MONGODB_URI) {
	// Only reached if globalSetup did not run (e.g. a bare node invocation).
	process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/${workerDb}`;
}

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-value-at-least-32-chars-long';
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
process.env.BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
