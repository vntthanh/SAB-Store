const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct } = require('../helpers/factories');

// Q4 (plan Phase 00 §B): `?available=all` used to bypass the availability
// filter entirely, exposing unavailable products on the public catalog.
describe('GET /api/products — ?available=all removed', () => {
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

	it('still supports explicitly listing unavailable products via available=false', async () => {
		const hidden = await makeProduct({ name: 'Explicit False Target', available: false });

		const res = await request(app).get('/api/products').query({ available: 'false' });

		expect(res.status).toBe(200);
		const names = res.body.data.products.map((p) => p.name);
		expect(names).toContain(hidden.name);
	});
});
