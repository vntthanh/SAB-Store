/**
 * Registry of listening servers built by helpers/app.js. Kept apart from the
 * app helper so tests/setup.js can close them without requiring server.js:
 * loading the app from a setup file binds every route module before a test
 * file's jest.mock() calls run.
 */
const servers = new Set();

function trackServer(server) {
	servers.add(server);
	return server;
}

async function closeTestServers() {
	await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
	servers.clear();
}

module.exports = { trackServer, closeTestServers };
