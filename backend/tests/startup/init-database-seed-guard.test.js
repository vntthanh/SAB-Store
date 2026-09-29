const mongoose = require('mongoose');
const Product = require('../../models/Product');
const User = require('../../models/User');
const Settings = require('../../models/Settings');
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
		logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
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

			expect(await User.countDocuments()).toBe(0);
			expect(await Settings.countDocuments()).toBe(0);
			expect(await Product.countDocuments()).toBe(0);
		});

		it('initialises an empty database when INIT_EMPTY_DATABASE names it, without sample products', async () => {
			process.env.INIT_EMPTY_DATABASE = mongoose.connection.name;

			await initDatabase();

			expect(await User.countDocuments({ email: 'init-admin@example.com' })).toBe(1);
			expect(await Product.countDocuments()).toBe(0);
		});

		it('ignores an opt-in that names a different database', async () => {
			// A flag left over from another deploy must not disable the guard.
			process.env.INIT_EMPTY_DATABASE = 'true';

			await expect(initDatabase()).rejects.toThrow(/looks empty/);
			expect(await User.countDocuments()).toBe(0);
		});

		it('creates the admin when other users exist but the admin does not', async () => {
			await User.collection.insertOne({ email: 'customer@example.com', username: 'customer', name: 'Customer' });

			await initDatabase();

			expect(await User.countDocuments({ email: 'init-admin@example.com' })).toBe(1);
		});

		it('does not require the opt-in once a user already exists', async () => {
			await User.collection.insertOne({
				email: process.env.ADMIN_EMAIL,
				username: process.env.ADMIN_USERNAME,
				name: 'Existing Admin',
			});

			await initDatabase();

			expect(await Product.countDocuments()).toBe(0);
		});

		it('leaves payment settings for the admin instead of inventing a bank account', async () => {
			process.env.INIT_EMPTY_DATABASE = mongoose.connection.name;
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			await initDatabase();

			expect(await Settings.countDocuments()).toBe(0);
			expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/admin Settings/));
			warnSpy.mockRestore();
		});

		it('keeps payment settings the admin already configured', async () => {
			process.env.INIT_EMPTY_DATABASE = mongoose.connection.name;
			await Settings.create({ bankNameId: 'VCB', bankAccountId: '1234567890123', prefixMessage: 'SAB' });

			await initDatabase();

			const settings = await Settings.findOne();
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

			expect(await Product.countDocuments()).toBe(2);
			const settings = await Settings.findOne();
			expect(settings.bankAccountId).toBe('0123456789');
		});
	});
});
