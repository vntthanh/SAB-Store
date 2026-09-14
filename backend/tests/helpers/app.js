/**
 * The real application under test.
 *
 * Always build it through createApp() from server.js. Assembling an app from
 * the routers directly would omit the middleware server.js mounts — including
 * the admin guard in front of /api/upload — and would quietly assert against an
 * app that is more permissive than the one that ships.
 */
const { createApp } = require('../../server');

function buildTestApp() {
	return createApp();
}

module.exports = { buildTestApp };
