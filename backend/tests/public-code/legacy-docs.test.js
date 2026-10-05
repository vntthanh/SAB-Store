/**
 * Products and combos stored before public codes existed must keep selling:
 * the public list, the price engine and order creation never require a code.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeLegacyProduct, makeLegacyCombo } = require('../helpers/factories');
const { expectedTotalFor } = require('../helpers/pricing');
const { computeOrderPricing } = require('../../services/pricing');
const Order = require('../../models/Order');

describe('documents without a public code', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('are listed in the public catalog', async () => {
		const legacy = await makeLegacyProduct({ name: 'Legacy Listed' });

		const res = await request(app).get('/api/products');

		expect(res.status).toBe(200);
		expect(res.body.data.products.map((p) => p.name)).toContain(legacy.name);
	});

	it('are priced with a legacy combo applied', async () => {
		const [a, b] = [await makeLegacyProduct(), await makeLegacyProduct()];
		await makeLegacyCombo();

		const pricing = await computeOrderPricing(
			[{ productId: String(a._id), quantity: 1 }, { productId: String(b._id), quantity: 1 }],
			{ channel: 'online' }
		);

		expect(pricing.totalAmount).toBe(150000);
		expect(pricing.comboInfo).not.toBeNull();
	});

	it('can be ordered', async () => {
		const product = await makeLegacyProduct();
		const items = [{ productId: String(product._id), quantity: 1 }];

		const res = await request(app).post('/api/orders').send({
			studentId: '24120001',
			fullName: 'Nguyen Van A',
			email: 'a@example.com',
			phoneNumber: '0987654321',
			items,
			expectedTotal: await expectedTotalFor(items)
		});

		expect(res.status).toBe(201);
		expect(await Order.countDocuments()).toBe(1);
	});
});
