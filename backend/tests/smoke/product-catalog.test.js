const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct } = require('../helpers/factories');

// Exercises the full stack the other smoke suites don't touch: a real
// mongoose document, written by createApp()'s real router, read back through
// the actual query the public catalog endpoint runs. Proves the harness's DB
// wiring (global-setup.js + setup.js) and factories.js work end to end, not
// just that the app boots.
describe('GET /api/products', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('lists a factory-created available product', async () => {
		const product = await makeProduct({ name: 'Smoke Test Lanyard', price: 50000 });

		const res = await request(app).get('/api/products');

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		const names = res.body.data.products.map((p) => p.name);
		expect(names).toContain(product.name);
	});

	it('excludes a product marked unavailable from the default listing', async () => {
		const hidden = await makeProduct({ name: 'Smoke Test Hidden Item', available: false });

		const res = await request(app).get('/api/products');

		expect(res.status).toBe(200);
		const names = res.body.data.products.map((p) => p.name);
		expect(names).not.toContain(hidden.name);
	});
});
