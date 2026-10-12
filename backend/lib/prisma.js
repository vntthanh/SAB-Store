const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('../generated/prisma/client');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	throw new Error('DATABASE_URL environment variable is required');
}

// One pool per process; production gets 10.
// Under test every Vitest fork opens its own pool against one shared server, so
// the default drops to TEST_PG_POOL_MAX (3) to stay far below max_connections.
const DEFAULT_POOL_MAX = 10;
const DEFAULT_TEST_POOL_MAX = 3;
const MAX_POOL_MAX = 50;

function readPoolMax() {
	const isTest = process.env.NODE_ENV === 'test';
	const raw = process.env.DATABASE_POOL_MAX || (isTest ? process.env.TEST_PG_POOL_MAX : undefined);
	if (!raw) return isTest ? DEFAULT_TEST_POOL_MAX : DEFAULT_POOL_MAX;
	const max = Number(raw);
	if (!Number.isInteger(max) || max < 1 || max > MAX_POOL_MAX) {
		throw new Error(`pool size must be an integer from 1 to ${MAX_POOL_MAX}; got ${raw}`);
	}
	return max;
}

const adapter = new PrismaPg({
	connectionString: DATABASE_URL,
	max: readPoolMax(),
	// Fail a request instead of queueing it behind an exhausted pool forever.
	connectionTimeoutMillis: 5000,
	idleTimeoutMillis: 30000,
	// Every session must be UTC. The adapter sends timestamps without an offset,
	// so a session on another zone stores the wrong instant while a JS round-trip
	// through the same pool still looks exact. Only SQL or another client sees it.
	options: '-c timezone=UTC',
});

const prisma = new PrismaClient({
	adapter,
	// maxWait bounds the wait for a pooled connection, timeout the whole
	// transaction; the defaults (2 s, 5 s) are too tight for an order plus its
	// stock movements under load.
	transactionOptions: { maxWait: 5000, timeout: 15000 },
});

/** Closes the pool. Safe to call more than once. */
async function closeDb() {
	await prisma.$disconnect();
}

module.exports = { prisma, closeDb };
