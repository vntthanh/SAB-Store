/**
 * A real Redis for queue tests, with no mocks: BullMQ runs Lua scripts that no
 * Redis fake implements.
 *
 * Provided in order of preference:
 *   1. REDIS_TEST_URL, if set (an externally managed server; it cannot be stopped
 *      or restarted by a test, so the outage test skips itself).
 *   2. redis-memory-server, which builds a Redis binary on first use (needs
 *      network and `make`, about a minute once, then cached) and starts it on a
 *      free port per suite.
 */
const { RedisMemoryServer } = require('redis-memory-server');

const REDIS_VERSION = '7.4.4';
// First use downloads and compiles Redis, far longer than the default hook timeout.
const START_TIMEOUT_MS = 180_000;

async function startRedis() {
	if (process.env.REDIS_TEST_URL) {
		return { url: process.env.REDIS_TEST_URL, external: true, stop: async () => {}, restart: async () => {} };
	}
	const server = new RedisMemoryServer({
		binary: { version: REDIS_VERSION }
	});
	await server.start();
	const host = await server.getHost();
	const actualPort = await server.getPort();
	return {
		url: `redis://${host}:${actualPort}`,
		external: false,
		stop: () => server.stop(),
		// Starting a stopped server again reuses its port, so clients reconnect to the same URL.
		restart: () => server.start()
	};
}

/** Poll until `check()` returns a truthy value; fail with `message` after `timeoutMs`. */
async function waitFor(check, { timeoutMs = 15_000, intervalMs = 50, message = 'condition not met' } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`waitFor timed out: ${message}`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

module.exports = { startRedis, waitFor, START_TIMEOUT_MS };
