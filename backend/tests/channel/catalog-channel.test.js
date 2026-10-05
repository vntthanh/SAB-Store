/**
 * Public catalog routes: GET /api/products is the online storefront,
 * GET /api/products/direct-sales is the counter.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');

const namesOf = (res) => res.body.data.products.map((p) => p.name);

describe('product catalog by sales channel', () => {
	let app;
	let cookies;

	beforeAll(() => {
		app = buildTestApp();
	});

	// The harness empties every collection after each test, sessions included.
	beforeEach(async () => {
		({ cookies } = await makeAdminSession(app));
	});

	it('refuses the counter list to anonymous callers', async () => {
		const res = await request(app).get('/api/products/direct-sales');
		expect(res.status).toBe(401);
	});

	it('lists an offline-only product in /direct-sales but not in /api/products', async () => {
		const offline = await makeProduct({ name: 'Counter Only', salesChannel: 'offline' });

		const direct = await request(app).get('/api/products/direct-sales').set('Cookie', cookies);
		const online = await request(app).get('/api/products');

		expect(namesOf(direct)).toContain(offline.name);
		expect(namesOf(online)).not.toContain(offline.name);
	});

	it('lists an online-only product in /api/products but not in /direct-sales', async () => {
		const onlineOnly = await makeProduct({ name: 'Web Only', salesChannel: 'online' });

		const direct = await request(app).get('/api/products/direct-sales').set('Cookie', cookies);
		const online = await request(app).get('/api/products');

		expect(namesOf(online)).toContain(onlineOnly.name);
		expect(namesOf(direct)).not.toContain(onlineOnly.name);
	});

	it('lists an "all" product on both', async () => {
		const both = await makeProduct({ name: 'Everywhere', salesChannel: 'all' });

		expect(namesOf(await request(app).get('/api/products'))).toContain(both.name);
		expect(namesOf(await request(app).get('/api/products/direct-sales').set('Cookie', cookies))).toContain(both.name);
	});

	it('hides available:false from both lists (the POS used to show "Ngừng bán" items)', async () => {
		const stopped = await makeProduct({ name: 'Stopped', available: false });

		expect(namesOf(await request(app).get('/api/products'))).not.toContain(stopped.name);
		expect(namesOf(await request(app).get('/api/products/direct-sales').set('Cookie', cookies))).not.toContain(stopped.name);
	});

	it('lists isActive:false when available:true on both (isActive is deprecated and unread)', async () => {
		const legacyFlag = await makeProduct({ name: 'Legacy Flag', isActive: false, available: true });

		expect(namesOf(await request(app).get('/api/products'))).toContain(legacyFlag.name);
		expect(namesOf(await request(app).get('/api/products/direct-sales').set('Cookie', cookies))).toContain(legacyFlag.name);
	});

	it('keeps category and search filters working next to the channel filter', async () => {
		const match = await makeProduct({ name: 'Blue Lanyard', category: 'lanyard', salesChannel: 'online' });
		await makeProduct({ name: 'Blue Sticker', category: 'sticker', salesChannel: 'online' });
		await makeProduct({ name: 'Blue Counter Lanyard', category: 'lanyard', salesChannel: 'offline' });

		const res = await request(app).get('/api/products').query({ category: 'lanyard', search: 'Blue' });

		expect(namesOf(res)).toEqual([match.name]);
	});

	it('never tells online customers the stock level', async () => {
		await makeProduct({ name: 'Counted', salesChannel: 'online', sku: 'SKU-LIST-1', stockQuantity: 3 });

		const res = await request(app).get('/api/products');

		const listed = res.body.data.products.find((p) => p.name === 'Counted');
		expect(listed).toBeDefined();
		expect(listed).not.toHaveProperty('stockQuantity');
		expect(listed).not.toHaveProperty('sku');
		expect(listed).not.toHaveProperty('isActive');
		const grouped = Object.values(res.body.data.groupedProducts).flat();
		expect(grouped.every((p) => !('stockQuantity' in p))).toBe(true);
	});

	it('ignores ?available=false: the public list never shows stopped products', async () => {
		const stopped = await makeProduct({ name: 'Explicit False Target', available: false });
		const selling = await makeProduct({ name: 'Selling Online', available: true });

		const res = await request(app).get('/api/products').query({ available: 'false' });

		expect(res.status).toBe(200);
		expect(namesOf(res)).toContain(selling.name);
		expect(namesOf(res)).not.toContain(stopped.name);
	});
});

describe('GET /api/products/:id', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('returns an online-sellable product without internal fields', async () => {
		const product = await makeProduct({ salesChannel: 'online', sku: 'SKU-DETAIL-1', stockQuantity: 9 });

		const res = await request(app).get(`/api/products/${product._id}`);

		expect(res.status).toBe(200);
		expect(res.body.data.name).toBe(product.name);
		expect(res.body.data).not.toHaveProperty('stockQuantity');
		expect(res.body.data).not.toHaveProperty('sku');
		expect(res.body.data).not.toHaveProperty('isActive');
	});

	it('404s for an offline-only product', async () => {
		const product = await makeProduct({ salesChannel: 'offline' });

		const res = await request(app).get(`/api/products/${product._id}`);

		expect(res.status).toBe(404);
	});

	it('404s for an available:false product', async () => {
		const product = await makeProduct({ available: false });

		const res = await request(app).get(`/api/products/${product._id}`);

		expect(res.status).toBe(404);
	});

	it('answers a malformed id with the same 404 as a hidden product', async () => {
		const res = await request(app).get('/api/products/not-an-id');

		expect(res.status).toBe(404);
	});
});
