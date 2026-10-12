const { makeSettings } = require('../helpers/factories');
const { countRows, findSettings, insertRawUser, databaseName } = require('../helpers/db');
const { initDatabase } = require('../../init-database');

const ENV_KEYS = [
	'NODE_ENV',
	'INIT_EMPTY_DATABASE',
	'ADMIN_EMAIL',
	'ADMIN_USERNAME',
	'ADMIN_PASSWORD',
];

describe('initDatabase seed guard', () => {
	let saved;
	let logSpy;

	beforeEach(() => {
		saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		process.env.ADMIN_EMAIL = 'init-admin@example.com';
		process.env.ADMIN_USERNAME = 'initadmin';
		process.env.ADMIN_PASSWORD = 'Init-Admin-Pass-123';
		delete process.env.INIT_EMPTY_DATABASE;
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		logSpy.mockRestore();
	});

	describe('in production', () => {
		beforeEach(() => {
			process.env.NODE_ENV = 'production';
		});

		it('refuses to initialise an empty database and creates nothing', async () => {
			await expect(initDatabase()).rejects.toThrow(/INIT_EMPTY_DATABASE=/);

			expect(await countRows('user')).toBe(0);
			expect(await countRows('settings')).toBe(0);
			expect(await countRows('product')).toBe(0);
		});

		it('initialises an empty database when INIT_EMPTY_DATABASE names it, without sample products', async () => {
			process.env.INIT_EMPTY_DATABASE = databaseName();

			await initDatabase();

			expect(await countRows('user', { email: 'init-admin@example.com' })).toBe(1);
			expect(await countRows('product')).toBe(0);
		});

		it('ignores an opt-in that names a different database', async () => {
			// A flag left over from another deploy must not disable the guard.
			process.env.INIT_EMPTY_DATABASE = 'true';

			await expect(initDatabase()).rejects.toThrow(/looks empty/);
			expect(await countRows('user')).toBe(0);
		});

		it('creates no user while an admin exists, even when ADMIN_* matches nobody', async () => {
			// The admin may have renamed the account; a second admin with the
			// deploy-time password must never appear.
			await insertRawUser({ email: 'renamed-admin@example.com', username: 'renamed', name: 'Renamed Admin', role: 'admin' });

			await initDatabase();

			expect(await countRows('user')).toBe(1);
			expect(await countRows('user', { email: 'init-admin@example.com' })).toBe(0);
		});

		it('boots without ADMIN_* while an admin exists', async () => {
			await insertRawUser({ email: 'renamed-admin@example.com', username: 'renamed', name: 'Renamed Admin', role: 'admin' });
			delete process.env.ADMIN_EMAIL;
			delete process.env.ADMIN_USERNAME;
			delete process.env.ADMIN_PASSWORD;

			await initDatabase();

			expect(await countRows('user')).toBe(1);
		});

		it('creates the admin from ADMIN_* when only a non-admin user exists, without the opt-in', async () => {
			// A store that lost its admin recovers from the deploy variables; the store
			// is not empty, so INIT_EMPTY_DATABASE is not needed.
			await insertRawUser({ email: 'customer@example.com', username: 'customer', name: 'Customer', role: 'user' });

			await initDatabase();

			expect(await countRows('user')).toBe(2);
			expect(await countRows('user', { email: 'init-admin@example.com', role: 'admin' })).toBe(1);
		});

		it('keeps booting without an admin when only a non-admin user exists and ADMIN_* is incomplete', async () => {
			// Throwing here would crash-loop a store that still serves its users.
			await insertRawUser({ email: 'customer@example.com', username: 'customer', name: 'Customer', role: 'user' });
			delete process.env.ADMIN_PASSWORD;
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			await initDatabase();

			expect(await countRows('user')).toBe(1);
			expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/no admin/));
			warnSpy.mockRestore();
		});

		it('requires ADMIN_* to create the first admin', async () => {
			process.env.INIT_EMPTY_DATABASE = databaseName();
			delete process.env.ADMIN_PASSWORD;

			await expect(initDatabase()).rejects.toThrow(/required to create the first admin/);
			expect(await countRows('user')).toBe(0);
		});

		it('does not require the opt-in once an admin already exists', async () => {
			await insertRawUser({
				email: process.env.ADMIN_EMAIL,
				username: process.env.ADMIN_USERNAME,
				name: 'Existing Admin',
				role: 'admin',
			});

			await initDatabase();

			expect(await countRows('product')).toBe(0);
		});

		it('leaves payment settings for the admin instead of inventing a bank account', async () => {
			process.env.INIT_EMPTY_DATABASE = databaseName();
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			await initDatabase();

			expect(await countRows('settings')).toBe(0);
			expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/admin Settings/));
			warnSpy.mockRestore();
		});

		it('keeps payment settings the admin already configured', async () => {
			process.env.INIT_EMPTY_DATABASE = databaseName();
			await makeSettings({ bankNameId: 'VCB', bankAccountId: '1234567890123', prefixMessage: 'SAB' });

			await initDatabase();

			const settings = await findSettings();
			expect(settings.bankNameId).toBe('VCB');
			expect(settings.bankAccountId).toBe('1234567890123');
		});
	});

	describe('outside production', () => {
		beforeEach(() => {
			process.env.NODE_ENV = 'test';
		});

		it('still seeds sample products and default settings on an empty database', async () => {
			await initDatabase();

			expect(await countRows('product')).toBe(2);
			const settings = await findSettings();
			expect(settings.bankAccountId).toBe('0123456789');
		});
	});
});
