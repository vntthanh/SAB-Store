const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');

// admin/products.js must never write stockQuantity: every stock change is a
// StockMovement applied by the ledger worker (adjustments go through
// POST /api/admin/products/:id/stock-adjustments), so an edit form can neither
// clobber nor bypass the ledger. Creation records the initial stock as an
// opening movement.
describe('Admin product routes never write stockQuantity directly', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('PUT /api/admin/products/:id ignores stockQuantity and still applies the other fields', async () => {
		const { cookies } = await makeAdminSession(app);
		const product = await makeProduct({ stockQuantity: 5 });

		const res = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ stockQuantity: 8, name: 'Renamed Via PUT' });

		expect(res.status).toBe(200);
		expect(res.body.data.product.name).toBe('Renamed Via PUT');
		const Product = require('../../models/Product');
		expect((await Product.findById(product._id).lean()).stockQuantity).toBe(5);
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

	it('POST /api/admin/products stores the initial stockQuantity', async () => {
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
		expect(res.body.data.product.stockQuantity).toBe(500);
	});
});
