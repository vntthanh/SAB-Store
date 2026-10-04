/**
 * Admin product routes — stockQuantity handling:
 *   - POST accepts stockQuantity as the opening balance (recorded in the ledger).
 *   - PUT ignores it: the cache changes only through stock movements.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');
const Product = require('../../models/Product');

describe('POST /api/admin/products — initial stockQuantity', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	it('stores the provided stockQuantity', async () => {
		const res = await request(app)
			.post('/api/admin/products')
			.set('Cookie', cookies)
			.send({ name: 'New Product', price: 10000, category: 'general', stockQuantity: 50 });

		expect(res.status).toBe(201);
		expect(res.body.data.product.stockQuantity).toBe(50);
	});

	it('defaults to 0 when stockQuantity is omitted', async () => {
		const res = await request(app)
			.post('/api/admin/products')
			.set('Cookie', cookies)
			.send({ name: 'New Product', price: 10000, category: 'general' });

		expect(res.status).toBe(201);
		expect(res.body.data.product.stockQuantity).toBe(0);
	});

	it('rejects a negative stockQuantity', async () => {
		const res = await request(app)
			.post('/api/admin/products')
			.set('Cookie', cookies)
			.send({ name: 'New Product', price: 10000, category: 'general', stockQuantity: -5 });

		expect(res.status).toBe(400);
	});
});

describe('PUT /api/admin/products/:id — stockQuantity is not editable', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	it.each([60, 30, -1, 'abc'])('ignores stockQuantity=%p', async (value) => {
		const product = await makeProduct({ stockQuantity: 50 });

		const res = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ name: 'Renamed', stockQuantity: value });

		expect(res.status).toBe(200);
		expect(res.body.data.product.stockQuantity).toBe(50);
		const stored = await Product.findById(product._id);
		expect(stored.stockQuantity).toBe(50);
		expect(stored.name).toBe('Renamed');
	});
});
