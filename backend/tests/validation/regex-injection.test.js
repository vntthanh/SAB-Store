const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');

// `?search=.*` used to compile straight into `{ $regex: search }` — every
// product matched. safeSearch() escapes the input first so it matches only
// the literal string.
describe('Regex injection via ?search', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('GET /api/products: ?search=.* matches nothing (not every product)', async () => {
		await makeProduct({ name: 'Unrelated Product' });

		const res = await request(app).get('/api/products').query({ search: '.*' });

		expect(res.status).toBe(200);
		expect(res.body.data.products).toEqual([]);
	});

	it('GET /api/products: search still matches a literal substring', async () => {
		const product = await makeProduct({ name: 'Findable Lanyard' });

		const res = await request(app).get('/api/products').query({ search: 'Findable' });

		expect(res.status).toBe(200);
		const names = res.body.data.products.map((p) => p.name);
		expect(names).toContain(product.name);
	});

	it('GET /api/admin/products: ?search=.* matches nothing', async () => {
		const { cookies } = await makeAdminSession(app);
		await makeProduct({ name: 'Admin Unrelated Product' });

		const res = await request(app)
			.get('/api/admin/products')
			.query({ search: '.*' })
			.set('Cookie', cookies);

		expect(res.status).toBe(200);
		expect(res.body.data.products).toEqual([]);
	});
});
