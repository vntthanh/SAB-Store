const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');
const Product = require('../../models/Product');

describe('Express routing contract', () => {
	let app;

	beforeAll(() => Product.init());
	beforeEach(() => {
		app = buildTestApp();
	});

	it('answers an unknown top-level path with the JSON 404, not the default HTML page', async () => {
		const res = await request(app).get('/definitely-not-a-route');

		expect(res.status).toBe(404);
		expect(res.headers['content-type']).toMatch(/application\/json/);
		expect(res.body.success).toBe(false);
	});

	it('answers a deep unknown path and non-GET methods with the same JSON 404', async () => {
		const deep = await request(app).get('/api/products/a/b/c/d');
		const post = await request(app).post('/api/nope/at/all').send({ a: 1 });

		expect(deep.status).toBe(404);
		expect(post.status).toBe(404);
		expect(post.body.success).toBe(false);
	});

	it('hands every /api/auth sub-path to Better Auth rather than the app 404', async () => {
		const res = await request(app).get('/api/auth/get-session');

		expect(res.status).toBe(200);
	});

	it('keeps repeated and bracketed query keys as plain strings or arrays, never operators', async () => {
		await makeProduct({ name: 'Alpha', category: 'cat-a', salesChannel: 'online' });
		await makeProduct({ name: 'Beta', category: 'cat-b', salesChannel: 'online' });

		const operator = await request(app).get('/api/products?category[$ne]=cat-a');
		const repeated = await request(app).get('/api/products?category=cat-a&category=cat-b');
		const searchOperator = await request(app).get('/api/products?search[$ne]=zzz');

		// Pins the parser: a nesting parser would turn the key into {category: {$ne}}
		// and return cat-b only. Under 'simple' the filter is ignored, so both come back.
		expect(operator.body.data.products).toHaveLength(2);
		for (const res of [operator, repeated, searchOperator]) {
			expect(res.status).toBe(200);
			expect(res.body.data.categories.sort()).toEqual(['cat-a', 'cat-b']);
		}
	});

	// Handlers destructure req.body directly; Express 5 leaves it undefined when
	// no parser ran, which would turn a validation 400 into a 500.
	it('answers a body-less admin POST with the handler validation 400, not a 500', async () => {
		const admin = await makeAdminSession(app);

		const noBody = await request(app).post('/api/combos').set('Cookie', admin.cookies);
		const plainText = await request(app).post('/api/combos').set('Cookie', admin.cookies).set('Content-Type', 'text/plain').send('hello');

		expect(noBody.status).toBe(400);
		expect(plainText.status).toBe(400);
	});

	it('keeps the admin and seller guards on path variants (case, trailing slash, encoded slash)', async () => {
		for (const base of ['/api/admin', '/api/seller']) {
			const upper = await request(app).get(`${base.toUpperCase()}/orders`);
			const trailing = await request(app).get(`${base}/orders/`);
			const encoded = await request(app).get(`${base}%2Forders`);

			expect([401, 404]).toContain(upper.status);
			expect(trailing.status).toBe(401);
			expect([401, 404]).toContain(encoded.status);
		}
	});

	it('routes a JSON POST under /api/auth to Better Auth, which rejects a wrong password with its own code', async () => {
		const res = await request(app).post('/api/auth/sign-in/username').send({ username: 'nobody_here', password: 'Wrong-pass-1' });

		expect(res.status).toBe(401);
		expect(res.body.code).toBeTruthy();
		expect(res.body.success).toBeUndefined();
	});
});
