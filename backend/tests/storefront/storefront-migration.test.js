/**
 * The storefronts migration on a database that already holds rows: the backfill
 * runs against real products, combos and orders, which the template (built empty)
 * never exercises.
 */
const fs = require('fs');
const path = require('path');
const { POSTGRES } = require('../helpers/backend');
const { withClient, databaseUrl, dropDatabase } = require('../helpers/postgres');
const { DEFAULT_STOREFRONT_ID } = require('../../data/default-storefront');

const MIGRATIONS = path.join(__dirname, '..', '..', 'prisma', 'migrations');
const STOREFRONTS = '20261025120000_storefronts';
const sqlOf = (name) => fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');

describe.skipIf(!POSTGRES)('storefronts migration on a populated database', () => {
	const dbName = `migration_${process.pid}`;
	let url;
	let rows;

	beforeAll(async () => {
		const server = process.env.PG_TEST_URI;
		await dropDatabase(server, dbName);
		await withClient(server, (client) => client.query(`CREATE DATABASE "${dbName}"`));
		url = databaseUrl(server, dbName);

		const earlier = fs.readdirSync(MIGRATIONS)
			.filter((entry) => /^\d+_/.test(entry) && entry < STOREFRONTS)
			.sort();

		rows = await withClient(url, async (client) => {
			for (const name of earlier) await client.query(sqlOf(name));

			await client.query(`
				INSERT INTO products (id, name, price, category, public_code, slug)
				VALUES (gen_random_uuid(), 'Ao', 10000, 'ao', 'P0000001', 'ao-p0000001'),
				       (gen_random_uuid(), 'Non', 20000, 'non', 'P0000002', 'non-p0000002')`);
			await client.query(`
				INSERT INTO combos (id, name, price, public_code, slug)
				VALUES ('11111111-1111-4111-8111-111111111111', 'Combo A', 30000, 'C0000001', 'combo-a-c0000001'),
				       ('22222222-2222-4222-8222-222222222222', 'Combo B', 40000, 'C0000002', 'combo-b-c0000002')`);
			await client.query(`
				INSERT INTO combo_category_requirements (id, combo_id, position, category, quantity)
				VALUES (gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 0, 'ao', 1)`);
			await client.query(`
				INSERT INTO orders (id, order_code, total_amount, is_direct_sale)
				VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ONLINE0001', 10000, false),
				       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'DIRECT0001', 20000, true)`);

			await client.query(sqlOf(STOREFRONTS));

			const read = async (text) => (await client.query(text)).rows;
			return {
				storefronts: await read('SELECT id, slug FROM storefronts'),
				links: await read(`
					SELECT id::text AS id, combo_id::text AS combo_id, storefront_id::text AS storefront_id,
					       substring(id::text, 15, 1) AS version, substring(id::text, 20, 1) AS variant
					FROM combo_storefronts`),
				products: await read('SELECT storefront_id::text AS storefront_id FROM products'),
				orders: await read('SELECT order_code, storefront_id::text AS storefront_id FROM orders ORDER BY order_code'),
				productNullable: (await read(`
					SELECT is_nullable FROM information_schema.columns
					WHERE table_name = 'products' AND column_name = 'storefront_id'`))[0].is_nullable,
			};
		});
	}, 60000);

	afterAll(async () => {
		await dropDatabase(process.env.PG_TEST_URI, dbName);
	});

	it('creates the default storefront with the constant id', () => {
		expect(rows.storefronts).toEqual([{ id: DEFAULT_STOREFRONT_ID, slug: 'cua-hang' }]);
	});

	it('links every existing combo to it, with a UUIDv7 id on each link', () => {
		expect(rows.links.map((link) => link.combo_id).sort()).toEqual([
			'11111111-1111-4111-8111-111111111111',
			'22222222-2222-4222-8222-222222222222',
		]);
		for (const link of rows.links) {
			expect(link.storefront_id).toBe(DEFAULT_STOREFRONT_ID);
			expect(link.version).toBe('7');
			expect(link.variant).toMatch(/^[89ab]$/);
		}
		expect(new Set(rows.links.map((link) => link.id)).size).toBe(2);
	});

	it('puts every existing product in it and makes the column required', () => {
		expect(rows.products).toHaveLength(2);
		for (const product of rows.products) expect(product.storefront_id).toBe(DEFAULT_STOREFRONT_ID);
		expect(rows.productNullable).toBe('NO');
	});

	it('stamps the online order and leaves the direct sale without a storefront', () => {
		expect(rows.orders).toEqual([
			{ order_code: 'DIRECT0001', storefront_id: null },
			{ order_code: 'ONLINE0001', storefront_id: DEFAULT_STOREFRONT_ID },
		]);
	});
});
