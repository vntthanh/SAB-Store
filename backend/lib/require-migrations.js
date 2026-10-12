/**
 * Refuses to boot against a database whose schema is not the one this image ships.
 *
 * The runtime image has no Prisma CLI, so the backend cannot migrate itself; the
 * one-shot release step does. Without this check, a backend that starts before (or
 * after a failed) release serves traffic against missing columns and answers every
 * request with an opaque 500.
 *
 * The check compares the migration directories shipped next to the code with the
 * rows of `_prisma_migrations`: a directory with no finished row is pending, and a
 * row that started but neither finished nor was marked rolled back is unfinished.
 * Prisma inserts a row before it runs the SQL, so a release step that is still
 * running looks the same as one that failed; both are reported as errors the
 * boot loop may retry, and only a row that carries Prisma's error log is worded
 * as a failure. A database that is ahead of the image (a rollback of the code) is
 * allowed.
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'prisma', 'migrations');
const UNDEFINED_TABLE = '42P01';

class MigrationsNotAppliedError extends Error {
	constructor(message) {
		super(message);
		this.name = 'MigrationsNotAppliedError';
	}
}

function shippedMigrations(dir) {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

function isMissingLedger(err) {
	return err?.meta?.code === UNDEFINED_TABLE || /_prisma_migrations.*does not exist/i.test(err?.message || '');
}

async function readLedger(prisma) {
	try {
		return await prisma.$queryRaw`SELECT migration_name, finished_at, rolled_back_at, logs FROM _prisma_migrations`;
	} catch (err) {
		if (isMissingLedger(err)) return null;
		throw err;
	}
}

/**
 * Resolves with the number of shipped migrations when all are applied; throws
 * MigrationsNotAppliedError naming the pending, running or failed ones otherwise.
 * The caller decides whether to wait and ask again.
 */
async function requireMigrationsApplied(prisma, dir = MIGRATIONS_DIR) {
	const shipped = shippedMigrations(dir);
	const rows = await readLedger(prisma);
	if (rows === null) {
		throw new MigrationsNotAppliedError(
			'The database has no _prisma_migrations table: run the release step (prisma migrate deploy) before starting the backend.'
		);
	}

	const finished = new Set(rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
	const unfinished = rows.filter((r) => !r.finished_at && !r.rolled_back_at);
	const unfinishedNames = new Set(unfinished.map((r) => r.migration_name));
	const failed = unfinished.filter((r) => r.logs).map((r) => r.migration_name);
	const running = unfinished.filter((r) => !r.logs).map((r) => r.migration_name);
	const pending = shipped.filter((name) => !finished.has(name) && !unfinishedNames.has(name));

	const problems = [];
	if (failed.length > 0) {
		problems.push(`Migration(s) failed and are not resolved: ${failed.join(', ')}. Fix the database, then run the release step again.`);
	}
	if (running.length > 0) {
		problems.push(`Migration(s) started but not finished (still running or interrupted): ${running.join(', ')}.`);
	}
	if (pending.length > 0) {
		problems.push(`Migration(s) not applied: ${pending.join(', ')}. Run the release step (prisma migrate deploy) before starting the backend.`);
	}
	if (problems.length > 0) throw new MigrationsNotAppliedError(problems.join(' '));
	return shipped.length;
}

module.exports = { requireMigrationsApplied, MigrationsNotAppliedError };
