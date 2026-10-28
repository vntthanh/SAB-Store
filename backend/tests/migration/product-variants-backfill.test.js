/**
 * The migration that introduced variants, run on a store that already holds
 * data: every migration before it is applied to a fresh database, rows are
 * written the way the previous release wrote them, then the variants migration
 * runs. Plain SQL files over one client, so the test sees exactly what
 * `migrate deploy` executes.
 */
const fs = require('fs');
const path = require('path');
const { v7: uuidv7 } = require('uuid');
const postgres = require('../helpers/postgres');
const { POSTGRES } = require('../helpers/backend');
const { DEFAULT_STOREFRONT_ID } = require('../../data/default-storefront');

const MIGRATIONS = path.join(__dirname, '..', '..', 'prisma', 'migrations');
const VARIANTS_MIGRATION = '20261028100000_product_variants';

const migrationSql = (name) => fs.readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');
const migrationsBefore = () => fs.readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort().filter((name) => name < VARIANTS_MIGRATION);

describe.skipIf(!POSTGRES)('product variants migration on existing data', () => {
	const dbName = `variants_mig_${process.pid}`;
	let url;

	beforeAll(async () => {
		await postgres.dropDatabase(process.env.PG_TEST_URI, dbName);
		await postgres.withClient(process.env.PG_TEST_URI, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(dbName)}`));
		url = postgres.databaseUrl(process.env.PG_TEST_URI, dbName);
		await postgres.withClient(url, async (client) => {
			for (const name of migrationsBefore()) await client.query(migrationSql(name));
		});
	});

	afterAll(async () => {
		await postgres.dropDatabase(process.env.PG_TEST_URI, dbName);
	});

	it('gives every product a default variant holding its stock and points lines and movements at it', async () => {
		const ids = { withImage: uuidv7(), emptyImage: uuidv7(), deleted: uuidv7(), order: uuidv7() };
		await postgres.withClient(url, async (client) => {
			const product = (id, imageUrl, stock, code) => client.query(
				`INSERT INTO products (id, name, price, category, public_code, slug, storefront_id, image_url, stock_quantity)
				 VALUES ($1, 'P', 1000, 'c', $2, 'p', $3, $4, $5)`,
				[id, code, DEFAULT_STOREFRONT_ID, imageUrl, stock]
			);
			await product(ids.withImage, '/uploads/a.jpg', -2, 'AAAAAAAA');
			await product(ids.emptyImage, '', 5, 'BBBBBBBB');
			await client.query(`INSERT INTO orders (id, order_code, total_amount) VALUES ($1, 'OLD01', 3000)`, [ids.order]);
			const line = (position, productId) => client.query(
				`INSERT INTO order_items (id, order_id, position, product_id, product_name, price, quantity) VALUES ($1, $2, $3, $4, 'P', 1000, 1)`,
				[uuidv7(), ids.order, position, productId]
			);
			await line(0, ids.withImage);
			await line(1, ids.deleted);
			const movement = (productId, key, status, delta) => client.query(
				`INSERT INTO stock_movements (id, product_id, type, delta, idempotency_key, status) VALUES ($1, $2, 'adjust', $3, $4, $5)`,
				[uuidv7(), productId, delta, key, status]
			);
			await movement(ids.withImage, 'm1', 'applied', -2);
			await movement(ids.emptyImage, 'm2', 'pending', 1);
			await movement(ids.deleted, 'm3', 'pending', 1);

			await client.query(migrationSql(VARIANTS_MIGRATION));

			const { rows: variants } = await client.query('SELECT * FROM product_variants ORDER BY product_id');
			expect(variants.map((v) => [v.product_id, v.option_values, v.stock_quantity, v.position, v.is_active])).toEqual([
				[ids.withImage, [], -2, 0, true],
				[ids.emptyImage, [], 5, 0, true]
			].sort((a, b) => a[0].localeCompare(b[0])));
			const variantOf = Object.fromEntries(variants.map((v) => [v.product_id, v.id]));

			const { rows: unequal } = await client.query(
				'SELECT p.id FROM products p JOIN product_variants v ON v.product_id = p.id WHERE v.stock_quantity <> p.stock_quantity'
			);
			expect(unequal).toEqual([]);

			const { rows: productsAfter } = await client.query('SELECT id, image_url, images FROM products');
			expect(Object.fromEntries(productsAfter.map((p) => [p.id, [p.image_url, p.images]]))).toEqual({
				[ids.withImage]: ['/uploads/a.jpg', ['/uploads/a.jpg']],
				[ids.emptyImage]: ['/fallback-product.png', []]
			});

			const { rows: lines } = await client.query('SELECT product_id, variant_id, variant_label FROM order_items ORDER BY position');
			expect(lines).toEqual([
				{ product_id: ids.withImage, variant_id: variantOf[ids.withImage], variant_label: null },
				{ product_id: ids.deleted, variant_id: null, variant_label: null }
			]);

			const { rows: moves } = await client.query('SELECT idempotency_key, product_id, variant_id FROM stock_movements ORDER BY seq');
			expect(moves[0].variant_id).toBe(variantOf[ids.withImage]);
			expect(moves[1].variant_id).toBe(variantOf[ids.emptyImage]);
			// A movement of a deleted product gets an id no variant has.
			expect(moves[2].variant_id).not.toBeNull();
			expect(Object.values(variantOf)).not.toContain(moves[2].variant_id);

			// The rules hold from here on.
			await expect(client.query(`UPDATE products SET image_url = '/uploads/x.jpg' WHERE id = $1`, [ids.withImage])).rejects.toMatchObject({ code: '23514' });
			await expect(client.query(`INSERT INTO stock_movements (id, product_id, type, delta, idempotency_key) VALUES ($1, $2, 'adjust', 1, 'm4')`, [uuidv7(), ids.withImage]))
				.rejects.toMatchObject({ code: '23502' });
		});
	});
});
