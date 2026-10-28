/**
 * Folding one-product-per-size stand-ins into one product with a Size option:
 * the target keeps its id and code, every other size becomes a variant that takes
 * over its stock (through movements) and its order lines, orders keep their codes
 * and totals, and a later cancel returns units to the right size.
 */
const request = require('supertest');
const { v7: uuidv7 } = require('uuid');
const data = require('../../data');
const { mergeIntoVariants } = require('../../data/postgres/product-merge');
const { recordMovement, reconcile } = require('../../services/stock-ledger');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const { insertRawProduct, findProduct, findOrderByCode } = require('../helpers/db');
const { applyPendingMovements } = require('../helpers/stock');
const { generatePublicCode } = require('../../utils/public-code');

const prisma = () => require('../../lib/prisma').prisma;

const shirt = (size, fields = {}) => insertRawProduct({
	name: `Áo SAB ${size}`, price: 250000, category: 'Áo', salesChannel: 'online', publicCode: generatePublicCode(), ...fields
});

/** Stock that came from the ledger: an applied movement on the product's default variant. */
async function stockThroughLedger(product, delta) {
	const movement = await recordMovement({ productId: product._id, type: 'adjust', delta, idempotencyKey: `seed-${uuidv7()}`, createdBy: 't', reason: 'r' });
	await require('../../services/stock-ledger').applyMovement(movement._id);
}

const run = (merge) => data.withTransaction((tx) => mergeIntoVariants(merge, tx, recordMovement));

describe('merging stand-in products into one product with an option', () => {
	let app;
	let admin;
	beforeEach(async () => {
		app = buildTestApp();
		admin = await makeAdminSession(app);
	});

	async function seed() {
		const xs = await shirt('XS', { imageUrl: '/uploads/products/common.jpg' });
		const m = await shirt('M', { imageUrl: '/uploads/products/m.jpg' });
		const l = await shirt('L', { imageUrl: '/uploads/products/common.jpg', salesChannel: 'all' });
		await stockThroughLedger(l, 2);
		const order = await request(app).post('/api/orders').send({
			studentId: '24120001', fullName: 'Nguyen Van A', email: 'a@example.com', phoneNumber: '0987654321',
			items: [{ productId: m._id, quantity: 1 }], expectedTotal: 250000
		});
		await applyPendingMovements();
		return { xs, m, l, orderCode: order.body.data.orderCode };
	}

	const mergeOf = ({ xs, m, l }) => ({
		targetId: xs._id, name: 'Áo SAB', optionName: 'Size', salesChannel: 'online',
		values: ['XS', 'M', 'L', 'XL'],
		sources: [{ productId: xs._id, value: 'XS' }, { productId: m._id, value: 'M' }, { productId: l._id, value: 'L' }]
	});

	it('moves stock and order lines to the new variants and keeps the order as it was', async () => {
		const seeded = await seed();
		const before = await findOrderByCode(seeded.orderCode);

		const result = await run(mergeOf(seeded));
		await applyPendingMovements();

		const target = await data.products.findById(seeded.xs._id);
		expect(target).toMatchObject({ name: 'Áo SAB', salesChannel: 'online', publicCode: seeded.xs.publicCode, images: ['/uploads/products/common.jpg', '/uploads/products/m.jpg'] });
		const variants = Object.fromEntries(target.variants.map((variant) => [variant.label, variant]));
		expect(Object.keys(variants)).toEqual(['XS', 'M', 'L', 'XL']);
		expect([variants.XS.stockQuantity, variants.M.stockQuantity, variants.L.stockQuantity, variants.XL.stockQuantity]).toEqual([0, -1, 2, 0]);
		expect(variants.M.imageUrl).toBe('/uploads/products/m.jpg');
		expect(target.stockQuantity).toBe(1);
		expect(result.retiredCodes.sort()).toEqual([seeded.m.publicCode, seeded.l.publicCode].sort());
		for (const retired of [seeded.m, seeded.l]) expect(await findProduct(retired._id)).toMatchObject({ available: false, isActive: false, stockQuantity: 0 });

		const after = await findOrderByCode(seeded.orderCode);
		expect(after).toMatchObject({ orderCode: before.orderCode, totalAmount: before.totalAmount, status: before.status });
		expect(after.items).toEqual([expect.objectContaining({ productId: seeded.xs._id, variantId: variants.M._id, variantLabel: 'M', productName: 'Áo SAB', price: 250000, quantity: 1 })]);
		expect(await reconcile()).toEqual([]);

		// Cancelling the order now returns its unit to the M variant.
		expect((await request(app).put(`/api/admin/orders/${after._id}`).set('Cookie', admin.cookies).send({ status: 'cancelled', cancelReason: 'x' })).status).toBe(200);
		await applyPendingMovements();
		expect((await data.products.findById(seeded.xs._id)).variants.find((variant) => variant.label === 'M').stockQuantity).toBe(0);
		expect(await reconcile()).toEqual([]);
	});

	it('refuses to run twice, with stock still pending, or across categories, writing nothing', async () => {
		const seeded = await seed();
		await run(mergeOf(seeded));
		await applyPendingMovements();
		await expect(run(mergeOf(seeded))).rejects.toThrow(/đã tắt|đã có phân loại/);

		const other = await seed();
		await recordMovement({ productId: other.l._id, type: 'adjust', delta: 1, idempotencyKey: `p-${uuidv7()}`, createdBy: 't', reason: 'r' });
		await expect(run(mergeOf(other))).rejects.toThrow(/chưa áp dụng/);
		await applyPendingMovements();

		await prisma().product.update({ where: { id: other.m._id }, data: { category: 'Mũ' } });
		await expect(run(mergeOf(other))).rejects.toThrow(/danh mục/);
		expect((await data.products.findById(other.xs._id)).options).toEqual([]);
	});
});
