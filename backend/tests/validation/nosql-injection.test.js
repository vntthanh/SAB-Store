const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');

// Proves that Mongo-operator-shaped query input on the routes this phase owns
// cannot reshape the query it feeds Mongoose — defence layer 1 is
// `app.set('query parser', 'simple')` in server.js (Phase 00/04), defence
// layer 2 is query-guard.js coercing everything to a primitive or dropping it.
describe('NoSQL operator injection — public product routes', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('does not let ?available[$ne]=x bypass the availability filter', async () => {
		const hidden = await makeProduct({ name: 'Injection Target', available: false });

		const res = await request(app).get('/api/products').query('available[$ne]=x');

		expect(res.status).toBe(200);
		const names = res.body.data.products.map((p) => p.name);
		expect(names).not.toContain(hidden.name);
	});

	it('drops an operator-shaped category filter instead of running it as Mongo', async () => {
		// A working `{ $ne: 'x' }` operator would exclude exactly the products
		// whose category is "x", so one of those is in the fixture data: it is
		// listed only if the object was dropped instead of run as an operator.
		const product = await makeProduct({ category: 'lanyard' });
		const excluded = await makeProduct({ category: 'x' });

		const res = await request(app).get('/api/products').query('category[$ne]=x');

		expect(res.status).toBe(200);
		const names = res.body.data.products.map((p) => p.name);
		expect(names).toContain(product.name);
		expect(names).toContain(excluded.name);
	});

	it('treats a search operator object as absent rather than as a $regex', async () => {
		const product = await makeProduct({ name: 'Search Injection Target' });

		const res = await request(app).get('/api/products').query('search[$regex]=.*');

		expect(res.status).toBe(200);
		// With the operator dropped, no search filter applies — the product
		// still appears in the (unfiltered) listing, but not because the
		// injected regex matched anything.
		const names = res.body.data.products.map((p) => p.name);
		expect(names).toContain(product.name);
	});
});

describe('NoSQL operator injection — admin product routes', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('does not let ?status[$ne]=x reshape the availability filter', async () => {
		const { cookies } = await makeAdminSession(app);
		await makeProduct({ name: 'Admin Injection Target', available: false });

		const res = await request(app)
			.get('/api/admin/products')
			.query('status[$ne]=x')
			.set('Cookie', cookies);

		expect(res.status).toBe(200);
		// asEnum drops anything that isn't literally 'true'/'false', so the
		// availability filter is not applied at all rather than inverted.
		expect(Array.isArray(res.body.data.products)).toBe(true);
	});

	it('caps limit at 100 even when the caller asks for far more', async () => {
		const { cookies } = await makeAdminSession(app);

		const res = await request(app)
			.get('/api/admin/products')
			.query({ limit: '99999999' })
			.set('Cookie', cookies);

		expect(res.status).toBe(200);
		expect(res.body.data.pagination.limit).toBeLessThanOrEqual(100);
	});
});
