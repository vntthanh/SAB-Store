/**
 * The real application under test.
 *
 * Always build it through createApp() from server.js. Assembling an app from
 * the routers directly would omit the middleware server.js mounts — including
 * the admin guard in front of /api/upload — and would quietly assert against an
 * app that is more permissive than the one that ships.
 *
 * Returns a server already listening on an ephemeral port (no host argument:
 * that binds synchronously, so a request in the same tick finds it listening).
 * Given a bare app, supertest opens and closes a server for every request; under the full
 * parallel suite that churn intermittently ended requests with ECONNRESET.
 * tests/setup.js closes every server built here after each file.
 */
const http = require('http');
const { createApp } = require('../../server');
const { trackServer } = require('./servers');

function buildTestApp() {
	return trackServer(http.createServer(createApp()).listen(0));
}

module.exports = { buildTestApp };
