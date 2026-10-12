const { listProducts, countRows } =require('../helpers/db');
const { PUBLIC_CODE_PATTERN } = require('../../utils/public-code');
const { initDatabase } = require('../../init-database');

const ENV_KEYS = ['NODE_ENV', 'INIT_EMPTY_DATABASE', 'ADMIN_EMAIL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'];

describe('initDatabase seed', () => {
	let saved;

	beforeEach(() => {
		saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		process.env.NODE_ENV = 'development';
		process.env.ADMIN_EMAIL = 'seed-admin@example.com';
		process.env.ADMIN_USERNAME = 'seedadmin';
		process.env.ADMIN_PASSWORD = 'Seed-Admin-Pass-123';
		delete process.env.INIT_EMPTY_DATABASE;
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		vi.restoreAllMocks();
	});

	it('gives every sample product, created by insertMany, a unique code and a slug', async () => {
		await initDatabase();

		const products = await listProducts();
		expect(products.length).toBeGreaterThan(0);
		for (const product of products) {
			expect(product.publicCode).toMatch(PUBLIC_CODE_PATTERN);
			expect(product.slug).toBeTruthy();
		}
		expect(new Set(products.map((p) => p.publicCode)).size).toBe(products.length);
	});

	it('seeds a mixed-case admin once and recognises it on the next run', async () => {
		// The auth library stores email and username lower-cased; a seed that compared
		// the raw env value would miss the admin on the second boot and fail creating it.
		process.env.ADMIN_EMAIL = 'Seed-Admin@Example.com';
		process.env.ADMIN_USERNAME = 'SeedAdmin';

		await initDatabase();
		await expect(initDatabase()).resolves.not.toThrow();

		expect(await countRows('user')).toBe(1);
	});
});
