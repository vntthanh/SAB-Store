/**
 * The default storefront: one fixed id shared by the migration, the code and the
 * test harness, and the rows the migration and the harness leave behind.
 */
const fs = require('fs');
const path = require('path');
const { POSTGRES } = require('../helpers/backend');
const { DEFAULT_STOREFRONT_ID, DEFAULT_STOREFRONT_SLUG, DEFAULT_STOREFRONT_NAME } = require('../../data/default-storefront');

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIGRATION = path.join(__dirname, '..', '..', 'prisma', 'migrations', '20261025120000_storefronts', 'migration.sql');

describe('default storefront constant', () => {
	it('is a UUIDv7', () => {
		expect(DEFAULT_STOREFRONT_ID).toMatch(UUID_V7);
	});

	it('is the id, slug and name the migration inserts, and the one it stamps on existing rows', () => {
		const sql = fs.readFileSync(MIGRATION, 'utf8');

		expect(sql).toContain(`VALUES ('${DEFAULT_STOREFRONT_ID}', '${DEFAULT_STOREFRONT_SLUG}', '${DEFAULT_STOREFRONT_NAME}', 'PUBLIC', 0)`);
		const literals = new Set(sql.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/g));
		expect([...literals]).toEqual([`'${DEFAULT_STOREFRONT_ID}'`]);
	});
});

describe.skipIf(!POSTGRES)('default storefront rows', () => {
	let prisma;
	let data;
	let factories;

	beforeAll(() => {
		({ prisma } = require('../../lib/prisma'));
		data = require('../../data');
		factories = require('../helpers/factories');
	});

	it('exists after the harness reset, with the constant id and a public, active state', async () => {
		const row = await prisma.storefront.findUnique({ where: { id: DEFAULT_STOREFRONT_ID } });

		expect(row).toMatchObject({ slug: DEFAULT_STOREFRONT_SLUG, name: DEFAULT_STOREFRONT_NAME, visibility: 'PUBLIC', sortOrder: 0, isActive: true });
		expect(await data.bootstrap.hasStorefront()).toBe(true);
	});

	it('reports a missing storefront to the seed', async () => {
		await prisma.$executeRaw`DELETE FROM storefronts`;
		try {
			expect(await data.bootstrap.hasStorefront()).toBe(false);
		} finally {
			await prisma.$executeRaw`INSERT INTO storefronts (id, slug, name) VALUES (${DEFAULT_STOREFRONT_ID}::uuid, ${DEFAULT_STOREFRONT_SLUG}, ${DEFAULT_STOREFRONT_NAME})`;
		}
	});

	it('puts a product without a storefront in the default one', async () => {
		const product = await data.products.create({ name: 'Plain', price: 1000, category: 'general' }, 0);

		expect(product.storefrontId).toBe(DEFAULT_STOREFRONT_ID);
		expect((await data.products.findById(product._id)).storefrontId).toBe(DEFAULT_STOREFRONT_ID);
	});

	it('refuses a product for a storefront that does not exist', async () => {
		const missing = '01a173f3-7280-71fd-b24f-000000000000';

		await expect(data.products.create({ name: 'Orphan', price: 1000, category: 'general', storefrontId: missing }, 0))
			.rejects.toMatchObject({ code: 'P2003' });
		expect(await prisma.product.count()).toBe(0);
	});

	it('links a combo without storefronts to the default one, and keeps the ids sorted', async () => {
		const combo = await factories.makeCombo();
		expect(combo.storefrontIds).toEqual([DEFAULT_STOREFRONT_ID]);

		const second = await prisma.storefront.create({ data: { slug: 'second', name: 'Second' } });
		const both = await data.combos.create({
			name: 'Both', price: 1000, categoryRequirements: [{ category: 'general', quantity: 1 }], storefrontIds: [second.id, DEFAULT_STOREFRONT_ID]
		});
		expect(both.storefrontIds).toEqual([DEFAULT_STOREFRONT_ID, second.id].sort());
	});

	it('refuses a combo with an empty storefront list', async () => {
		await expect(data.combos.create({
			name: 'None', price: 1000, categoryRequirements: [{ category: 'general', quantity: 1 }], storefrontIds: []
		})).rejects.toMatchObject({ name: 'RecordValidationError' });
	});

	it('stamps the default storefront on factory products and online orders, and a direct sale record has none', async () => {
		const product = await factories.makeProduct();
		const online = await factories.makeOrder();
		const direct = await factories.makeOrder({ isDirectSale: true });

		expect(product.storefrontId).toBe(DEFAULT_STOREFRONT_ID);
		expect(online.storefrontId).toBe(DEFAULT_STOREFRONT_ID);
		expect('storefrontId' in direct).toBe(false);
	});
});
