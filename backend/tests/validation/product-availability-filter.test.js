const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct } = require('../helpers/factories');

// The public catalog lists only products sellable online. No query parameter
// (`?available=all`, `?available=false`) may widen that and expose stopped products.
describe('GET /api/products — availability query parameters never widen the list', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('still excludes unavailable products when available=all is passed', async () => {
		const hidden = await makeProduct({ name: 'Should Stay Hidden', available: false });
		const shown = await makeProduct({ name: 'Should Stay Visible', available: true });

		const res = await request(app).get('/api/products').query({ available: 'all' });

		expect(res.status).toBe(200);
		const names = res.body.data.products.map((p) => p.name);
		expect(names).not.toContain(hidden.name);
		expect(names).toContain(shown.name);
	});

	it('defaults to available-only with no query param at all', async () => {
		const hidden = await makeProduct({ name: 'Default Hidden', available: false });

		const res = await request(app).get('/api/products');

		expect(res.status).toBe(200);
		const names = res.body.data.products.map((p) => p.name);
		expect(names).not.toContain(hidden.name);
	});

	it('ignores available=false: the public list never shows stopped products', async () => {
		const hidden = await makeProduct({ name: 'Explicit False Target', available: false });

		const res = await request(app).get('/api/products').query({ available: 'false' });

		expect(res.status).toBe(200);
		const names = res.body.data.products.map((p) => p.name);
		expect(names).not.toContain(hidden.name);
	});
});
