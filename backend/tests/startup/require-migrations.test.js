const fs = require('fs');
const os = require('os');
const path = require('path');
const { requireMigrationsApplied, MigrationsNotAppliedError } = require('../../lib/require-migrations');

const SHIPPED_DIR = path.resolve(__dirname, '../../prisma/migrations');
const NOW = new Date();

const finished = (name) => ({ migration_name: name, finished_at: NOW, rolled_back_at: null, logs: null });
// Prisma records the error text of a migration that failed; a row still being applied has none.
const failed = (name) => ({ migration_name: name, finished_at: null, rolled_back_at: null, logs: 'ERROR: syntax error' });
const running = (name) => ({ migration_name: name, finished_at: null, rolled_back_at: null, logs: null });
const rolledBack = (name) => ({ migration_name: name, finished_at: null, rolled_back_at: NOW, logs: 'ERROR: syntax error' });

const ledger = (rows) => ({ $queryRaw: vi.fn().mockResolvedValue(rows) });

describe('requireMigrationsApplied', () => {
	let dir;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-migrations-'));
		for (const name of ['001_init', '002_add_column']) fs.mkdirSync(path.join(dir, name));
		// The lock file sits next to the migration directories and is not a migration.
		fs.writeFileSync(path.join(dir, 'migration_lock.toml'), 'provider = "postgresql"\n');
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// The two tests that read the real ledger open the Prisma pool.
	afterAll(async () => {
		await require('../../lib/prisma').closeDb();
	});

	it('resolves with the number of shipped migrations when every one is finished', async () => {
		const prisma = ledger([finished('001_init'), finished('002_add_column')]);
		await expect(requireMigrationsApplied(prisma, dir)).resolves.toBe(2);
	});

	it('accepts a database that is ahead of the image', async () => {
		const prisma = ledger([finished('001_init'), finished('002_add_column'), finished('003_from_a_newer_release')]);
		await expect(requireMigrationsApplied(prisma, dir)).resolves.toBe(2);
	});

	it('names a shipped migration that has no row', async () => {
		const prisma = ledger([finished('001_init')]);
		await expect(requireMigrationsApplied(prisma, dir)).rejects.toThrow(/not applied: 002_add_column/);
	});

	it('treats a migration marked rolled back as pending', async () => {
		const prisma = ledger([finished('001_init'), rolledBack('002_add_column')]);
		await expect(requireMigrationsApplied(prisma, dir)).rejects.toThrow(/not applied: 002_add_column/);
	});

	it('words a migration that recorded an error as failed', async () => {
		const prisma = ledger([finished('001_init'), failed('002_add_column')]);
		const error = await requireMigrationsApplied(prisma, dir).catch((err) => err);
		expect(error.message).toMatch(/failed and are not resolved: 002_add_column/);
		expect(error.message).not.toMatch(/not applied/);
	});

	it('words a migration that started and has no error yet as still running, not as failed', async () => {
		// Prisma inserts the row before it runs the SQL, so a release step in progress looks like this.
		const prisma = ledger([finished('001_init'), running('002_add_column')]);
		const error = await requireMigrationsApplied(prisma, dir).catch((err) => err);
		expect(error).toBeInstanceOf(MigrationsNotAppliedError);
		expect(error.message).toMatch(/not finished \(still running or interrupted\): 002_add_column/);
		expect(error.message).not.toMatch(/failed/);
	});

	it('names every kind of problem in one message', async () => {
		const prisma = ledger([failed('001_init'), running('002_add_column')]);
		fs.mkdirSync(path.join(dir, '003_pending'));
		const error = await requireMigrationsApplied(prisma, dir).catch((err) => err);
		expect(error.message).toMatch(/failed .*001_init/);
		expect(error.message).toMatch(/not finished .*002_add_column/);
		expect(error.message).toMatch(/not applied: 003_pending/);
	});

	it('reports a database that was never migrated', async () => {
		const missingTable = Object.assign(new Error('relation "_prisma_migrations" does not exist'), { meta: { code: '42P01' } });
		const prisma = { $queryRaw: vi.fn().mockRejectedValue(missingTable) };
		await expect(requireMigrationsApplied(prisma, dir)).rejects.toThrow(/no _prisma_migrations table/);
	});

	it('refuses with a typed error that carries no fatal flag, so the boot loop may retry it', async () => {
		const error = await requireMigrationsApplied(ledger([]), dir).catch((err) => err);
		expect(error).toBeInstanceOf(MigrationsNotAppliedError);
		expect(error.fatal).toBeUndefined();
	});

	it('does not swallow a failure that is not a missing ledger', async () => {
		const prisma = { $queryRaw: vi.fn().mockRejectedValue(new Error('connection terminated')) };
		await expect(requireMigrationsApplied(prisma, dir)).rejects.toThrow('connection terminated');
	});

	// The shipped directories and the template database both come from the real
	// migration files, so this proves the check agrees with what `migrate deploy` wrote.
	it('passes against the migrated test database with the shipped migrations', async () => {
		const { prisma } = require('../../lib/prisma');
		const shipped = fs.readdirSync(SHIPPED_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
		await expect(requireMigrationsApplied(prisma)).resolves.toBe(shipped);
	});

	it('refuses the migrated test database when the image ships one more migration', async () => {
		const { prisma } = require('../../lib/prisma');
		for (const entry of fs.readdirSync(SHIPPED_DIR, { withFileTypes: true })) {
			if (entry.isDirectory()) fs.mkdirSync(path.join(dir, entry.name));
		}
		fs.mkdirSync(path.join(dir, '99999999999999_not_yet_released'));
		await expect(requireMigrationsApplied(prisma, dir)).rejects.toThrow(/not applied: .*99999999999999_not_yet_released/);
	});
});
