const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');

// admin/products.js must never write stockQuantity absolutely: a concurrent
// admin edit would clobber a guarded decrement mid-checkout. The admin UI still
// offers a stock field, so the route accepts the value and routes it through the
// atomic path instead of dropping it — silently discarding admin input is its
// own defect. Creation takes the value directly, since nothing can race a
// product that does not exist yet.
describe('Admin product routes never write stockQuantity absolutely', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('PUT /api/admin/products/:id applies stockQuantity as a delta', async () => {
		const { cookies } = await makeAdminSession(app);
		const product = await makeProduct({ stockQuantity: 5 });

		const res = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ stockQuantity: 8, name: 'Renamed Via PUT' });

		expect(res.status).toBe(200);
		expect(res.body.data.product.stockQuantity).toBe(8);
		expect(res.body.data.product.name).toBe('Renamed Via PUT');
	});

	// Composition under true concurrency is guaranteed by the atomic $inc in
	// services/stock.js and is tested there (tests/stock/*). Asserting it over
	// HTTP cannot work: the two requests may serialise, in which case the second
	// observes the already-updated value, computes a zero delta and is correct to
	// leave stock alone — so the assertion would be timing-dependent, not a real
	// invariant.

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
