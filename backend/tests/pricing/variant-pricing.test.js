/**
 * Prices and orders per variant: each unit costs its variant's price (or the
 * product's when the variant has none), lines of different variants stay apart
 * through pricing, the stored order and the stock ledger, and a line that names
 * no variant buys only a product without options.
 */
const request = require('supertest');
const { computeOrderPricing } = require('../../services/pricing');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeOrder, makeAdminSession } = require('../helpers/factories');
const { insertRawProductWithOptions, findOrderByCode, movementsFor, stockOf } = require('../helpers/db');
const { applyPendingMovements } = require('../helpers/stock');
const { generatePublicCode } = require('../../utils/public-code');

const ONLINE = { channel: 'online' };
const prisma = () => require('../../lib/prisma').prisma;

/** "Áo" in category `ao`, Size S (10 000, the product price) and M (12 000), plus an inactive L. */
async function shirt(fields = {}) {
	const { product, variants } = await insertRawProductWithOptions({
		name: 'Áo SAB', price: 10000, category: 'ao', publicCode: generatePublicCode(),
		options: [{ name: 'Size', values: ['S', 'M', 'L'] }],
		variants: [{ optionValues: ['S'] }, { optionValues: ['M'], price: 12000 }, { optionValues: ['L'], isActive: false }],
		...fields
	});
	const [small, medium, large] = variants;
	return { product, small, medium, large };
}

const variantLine = (product, variant, quantity) => ({ productId: product._id, variantId: variant._id, quantity });

describe('pricing per variant', () => {
	it('prices each variant at its own price, or the product price, as separate lines', async () => {
		const { product, small, medium } = await shirt();

		const result = await computeOrderPricing([variantLine(product, small, 2), variantLine(product, medium, 1), variantLine(product, small, 1)], ONLINE);

		expect(result.totalAmount).toBe(3 * 10000 + 12000);
		expect(result.orderItems).toEqual(expect.arrayContaining([
			expect.objectContaining({ productId: product._id, variantId: small._id, variantLabel: 'S', price: 10000, quantity: 3 }),
			expect.objectContaining({ productId: product._id, variantId: medium._id, variantLabel: 'M', price: 12000, quantity: 1 })
		]));
		expect(result.orderItems).toHaveLength(2);
	});

	it('names exactly the bad lines: no variant for a product with options, an inactive one, one of another product', async () => {
		const { product, small, large } = await shirt();
		const other = await shirt();

		await expect(computeOrderPricing([{ productId: product._id, quantity: 1 }, variantLine(product, small, 1)], ONLINE))
			.rejects.toMatchObject({ code: 'VARIANT_REQUIRED', details: { lines: [{ productId: product._id, variantId: null }] } });
		await expect(computeOrderPricing([variantLine(product, large, 1), variantLine(product, other.small, 1), variantLine(product, small, 1)], ONLINE))
			.rejects.toMatchObject({ code: 'VARIANT_UNAVAILABLE', details: { lines: [{ productId: product._id, variantId: large._id }, { productId: product._id, variantId: other.small._id }] } });
	});

	it('buys the default variant of a product without options when the line names none, and stores its id', async () => {
		const plain = await makeProduct({ price: 5000 });

		const result = await computeOrderPricing([{ productId: String(plain._id), quantity: 2 }], ONLINE);

		expect(result.orderItems).toEqual([expect.objectContaining({ productId: String(plain._id), variantId: expect.any(String), price: 5000, quantity: 2 })]);
		expect(result.orderItems[0]).not.toHaveProperty('variantLabel');
	});

	it('applies a category combo to variant units at their own prices', async () => {
		const { product, small, medium } = await shirt();
		await makeCombo({ price: 20000, categoryRequirements: [{ category: 'ao', quantity: 2 }] });

		const result = await computeOrderPricing([variantLine(product, small, 1), variantLine(product, medium, 1)], ONLINE);

		expect(result.originalTotal).toBe(22000);
		expect(result.totalAmount).toBe(20000);
		expect(result.orderItems.every((item) => item.fromCombo)).toBe(true);
		expect(result.orderItems.map((item) => [item.variantLabel, item.price]).sort()).toEqual([['M', 12000], ['S', 10000]]);
	});

	it('checks the product\'s minimum and maximum against the units of all its variants', async () => {
		const { product, small, medium } = await shirt({ minOrderQuantity: 3, maxOrderQuantity: 4 });

		await expect(computeOrderPricing([variantLine(product, small, 1), variantLine(product, medium, 1)], { ...ONLINE, enforceQuantityLimits: true }))
			.rejects.toMatchObject({ code: 'QUANTITY_OUT_OF_RANGE', details: { reason: 'below_min', quantity: 2 } });
		await expect(computeOrderPricing([variantLine(product, small, 2), variantLine(product, medium, 2)], { ...ONLINE, enforceQuantityLimits: true }))
			.resolves.toMatchObject({ totalAmount: 44000 });
		await expect(computeOrderPricing([variantLine(product, small, 3), variantLine(product, medium, 2)], { ...ONLINE, enforceQuantityLimits: true }))
			.rejects.toMatchObject({ code: 'QUANTITY_OUT_OF_RANGE', details: { reason: 'above_max' } });
	});
});

describe('orders per variant', () => {
	let app;
	let admin;
	const customer = { studentId: '24120001', fullName: 'Nguyen Van A', email: 'a@example.com', phoneNumber: '0987654321' };

	beforeAll(() => {
		app = buildTestApp();
	});
	beforeEach(async () => {
		admin = await makeAdminSession(app);
	});

	const variantStock = async (variant) => (await prisma().productVariant.findUnique({ where: { id: variant._id } })).stockQuantity;

	it('stores one line and one movement per variant, and a cancel gives each variant its units back', async () => {
		const { product, small, medium } = await shirt();

		const res = await request(app).post('/api/orders').send({ ...customer, items: [variantLine(product, small, 2), variantLine(product, medium, 1)], expectedTotal: 32000 });
		expect(res.status).toBe(201);
		const order = await findOrderByCode(res.body.data.orderCode);
		expect(order.items.map((item) => [item.variantId, item.variantLabel, item.quantity]).sort()).toEqual([[medium._id, 'M', 1], [small._id, 'S', 2]].sort());

		await applyPendingMovements();
		expect([await variantStock(small), await variantStock(medium), await stockOf(product._id)]).toEqual([-2, -1, -3]);

		const tracked = await request(app).get(`/api/orders/${order.orderCode}`);
		expect(tracked.body.data.items.map((item) => item.variantLabel).sort()).toEqual(['M', 'S']);

		expect((await request(app).put(`/api/admin/orders/${order._id}`).set('Cookie', admin.cookies).send({ status: 'cancelled', cancelReason: 'x' })).status).toBe(200);
		await applyPendingMovements();
		expect([await variantStock(small), await variantStock(medium), await stockOf(product._id)]).toEqual([0, 0, 0]);
		const keys = (await movementsFor(product._id)).map((movement) => movement.idempotencyKey);
		expect(keys).toEqual(expect.arrayContaining([`order:${order._id}:${small._id}:create`, `order:${order._id}:${medium._id}:create`]));
	});

	it('sells a chosen variant at the counter, the line naming it', async () => {
		const { product, medium } = await shirt();

		const res = await request(app).post('/api/seller/orders/direct').set('Cookie', admin.cookies).send({ items: [variantLine(product, medium, 2)], expectedTotal: 24000 });

		expect(res.status).toBe(201);
		expect((await findOrderByCode(res.body.data.orderCode)).items).toEqual([expect.objectContaining({ variantId: medium._id, variantLabel: 'M', price: 12000, quantity: 2 })]);
		await applyPendingMovements();
		expect(await variantStock(medium)).toBe(-2);
	});

	it('refuses a total computed with the product price instead of the variant price', async () => {
		const { product, medium } = await shirt();

		const res = await request(app).post('/api/orders').send({ ...customer, items: [variantLine(product, medium, 1)], expectedTotal: 10000 });

		expect(res.status).toBe(409);
		expect(res.body).toMatchObject({ code: 'PRICE_CHANGED', details: { expectedTotal: 10000, totalAmount: 12000 } });
	});

	it('answers 400 naming an inactive or archived variant at the counter', async () => {
		const { product, small, large } = await shirt();
		await prisma().productVariant.update({ where: { id: small._id }, data: { isActive: false, archivedAt: new Date() } });

		const res = await request(app).post('/api/seller/orders/direct').set('Cookie', admin.cookies)
			.send({ items: [variantLine(product, small, 1), variantLine(product, large, 1)], expectedTotal: 20000 });

		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({ code: 'VARIANT_UNAVAILABLE', details: { lines: [{ variantId: small._id }, { variantId: large._id }] } });
	});

	it('answers 400 naming the line when an online cart names no variant of a product with options', async () => {
		const { product } = await shirt();

		const res = await request(app).post('/api/orders').send({ ...customer, items: [{ productId: product._id, quantity: 1 }], expectedTotal: 10000 });

		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({ code: 'VARIANT_REQUIRED', details: { lines: [{ productId: product._id, variantId: null }] } });
	});

	it('lets an admin swap a variant at the same total, moving stock between the two variants', async () => {
		const { product, variants: [small, extraLarge] } = await insertRawProductWithOptions({
			name: 'Áo SAB', price: 10000, category: 'ao', publicCode: generatePublicCode(),
			options: [{ name: 'Size', values: ['S', 'XL'] }], variants: [{ optionValues: ['S'] }, { optionValues: ['XL'] }]
		});
		const placed = await request(app).post('/api/orders').send({ ...customer, items: [variantLine(product, small, 1)], expectedTotal: 10000 });
		const order = await findOrderByCode(placed.body.data.orderCode);

		const res = await request(app).put(`/api/admin/orders/${order._id}/items`).set('Cookie', admin.cookies)
			.send({ items: [variantLine(product, extraLarge, 1)], expectedRevision: 0, reason: 'đổi size' });

		expect(res.status).toBe(200);
		expect((await findOrderByCode(order.orderCode)).items.map((item) => item.variantLabel)).toEqual(['XL']);
		const editKeys = (await movementsFor(product._id)).filter((movement) => movement.type === 'order_edit').map((movement) => movement.idempotencyKey);
		expect(editKeys.sort()).toEqual([`order:${order._id}:${small._id}:edit:1`, `order:${order._id}:${extraLarge._id}:edit:1`].sort());
		await applyPendingMovements();
		expect([await variantStock(small), await variantStock(extraLarge), await stockOf(product._id)]).toEqual([0, -1, -1]);
	});

	it('keeps an order editable after one of its variants is retired', async () => {
		const { product, small, medium } = await shirt();
		const placed = await request(app).post('/api/orders').send({ ...customer, items: [variantLine(product, small, 1), variantLine(product, medium, 1)], expectedTotal: 22000 });
		const order = await findOrderByCode(placed.body.data.orderCode);
		await prisma().productVariant.update({ where: { id: medium._id }, data: { isActive: false, archivedAt: new Date() } });

		// The retired M line is sent back as it is, in another order: re-pricing must still accept M.
		const res = await request(app).put(`/api/admin/orders/${order._id}/items`).set('Cookie', admin.cookies)
			.send({ items: [variantLine(product, medium, 1), variantLine(product, small, 1)], expectedRevision: 0, reason: 'xem lại' });

		expect(res.status).toBe(200);
		expect(await prisma().stockMovement.count({ where: { productId: product._id, type: 'order_edit' } })).toBe(0);
	});

	it('reads a stored line without a variant as the default variant, so an unchanged edit records nothing', async () => {
		const plain = await makeProduct({ price: 5000 });
		const order = await makeOrder({ items: [{ productId: plain._id, productName: plain.name, price: 5000, quantity: 2 }], totalAmount: 10000, stockDeducted: true });

		const res = await request(app).put(`/api/admin/orders/${order._id}/items`).set('Cookie', admin.cookies)
			.send({ items: [{ productId: String(plain._id), quantity: 2 }], expectedRevision: 0, reason: 'xem lại' });

		expect(res.status).toBe(200);
		expect(await prisma().stockMovement.count({ where: { productId: String(plain._id), type: 'order_edit' } })).toBe(0);
	});
});
