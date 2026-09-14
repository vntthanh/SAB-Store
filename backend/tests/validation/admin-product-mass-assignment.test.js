const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');

// Phase 06 owns the atomic stock path (services/stock.js). If admin/products.js
// still wrote stockQuantity absolutely, a concurrent admin edit could clobber
// a guarded stock decrement mid-checkout. destructure must exclude it.
describe('Admin product routes reject absolute stockQuantity writes', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('PUT /api/admin/products/:id ignores stockQuantity in the body', async () => {
		const { cookies } = await makeAdminSession(app);
		const product = await makeProduct({ stockQuantity: 5 });

		const res = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ stockQuantity: 999999, name: 'Renamed Via PUT' });

		expect(res.status).toBe(200);
		expect(res.body.data.product.stockQuantity).toBe(5);
		expect(res.body.data.product.name).toBe('Renamed Via PUT');
	});

	it('PUT /api/admin/products/:id ignores createdAt and sku in the body', async () => {
		const { cookies } = await makeAdminSession(app);
		const product = await makeProduct();
		const forgedDate = new Date('2000-01-01').toISOString();

		const res = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ createdAt: forgedDate, sku: 'forged-sku' });

		expect(res.status).toBe(200);
		expect(new Date(res.body.data.product.createdAt).toISOString()).not.toBe(forgedDate);
		expect(res.body.data.product.sku).not.toBe('forged-sku');
	});

	it('POST /api/admin/products always creates with stockQuantity 0 regardless of input', async () => {
		const { cookies } = await makeAdminSession(app);

		const res = await request(app)
			.post('/api/admin/products')
			.set('Cookie', cookies)
			.send({
				name: 'New Product Via POST',
				price: 10000,
				category: 'general',
				stockQuantity: 500
			});

		expect(res.status).toBe(201);
		expect(res.body.data.product.stockQuantity).toBe(0);
	});
});
