/**
 * Start the database server for the whole run.
 *
 * PostgreSQL starts (or the TEST_DATABASE_URL server is used) with the per-file
 * template already built, so a broken start fails the whole run instead of
 * surfacing later as a partial suite.
 *
 * It starts in vitest's `globalSetup` (the main Node process) rather than in a
 * per-suite hook: one shared server beats booting one per suite.
 */
const { startTestPostgres } = require('./helpers/postgres');

module.exports = async function globalSetup() {
	const postgres = await startTestPostgres();

	// Handed to the worker processes, which cannot share the object itself: the
	// forks are spawned after this runs and inherit the main process environment.
	process.env.PG_TEST_URI = postgres.uri;
	process.env.PG_TEST_TEMPLATE = postgres.template;

	// Vitest calls the returned function once after the whole run.
	return async function globalTeardown() {
		await postgres.stop();
	};
};
