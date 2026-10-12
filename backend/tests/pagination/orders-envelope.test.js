const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeOrder, makeProduct, makeAdminSession } = require('../helpers/factories');
const { deleteProduct } = require('../helpers/db');

// GET /api/admin/orders and GET /api/seller/orders answer { success, data, meta }.
// This replaces { data: { orders, pagination } } on purpose: it is the shared
// list envelope, and `meta.totalPages` is 0 (not 1) for no rows.
describe.each([
	['admin', '/api/admin/orders'],
	['seller', '/api/seller/orders']
])('GET %s orders — list envelope', (_role, path) => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app)); // admin role passes authenticateSeller too
	});

	const list = (query = {}) => request(app).get(path).query(query).set('Cookie', cookies);

	it('answers data as an array of orders and meta with page, limit, total and totalPages', async () => {
		for (let i = 0; i < 5; i += 1) await makeOrder();

		const res = await list({ page: 2, limit: 2 });

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data).toHaveLength(2);
		expect(res.body.data[0]).toEqual(expect.objectContaining({ orderCode: expect.any(String), items: expect.any(Array) }));
		expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
	});

	it('returns the short last page and an empty page past the end', async () => {
		for (let i = 0; i < 5; i += 1) await makeOrder();

		const last = await list({ page: 3, limit: 2 });
		const beyond = await list({ page: 9, limit: 2 });

		expect(last.body.data).toHaveLength(1);
		expect(beyond.body.data).toEqual([]);
		expect(beyond.body.meta).toEqual({ page: 9, limit: 2, total: 5, totalPages: 3 });
	});

	it('reports totalPages 0 when nothing matches', async () => {
		const res = await list({ search: 'nothing-has-this-name' });

		expect(res.body.data).toEqual([]);
		expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
	});

	it('counts the filtered rows, not the whole collection', async () => {
		await makeOrder({ status: 'paid' });
		await makeOrder({ status: 'paid' });
		await makeOrder({ status: 'delivered' });

		const res = await list({ status: 'paid', limit: 1 });

		expect(res.body.meta).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
	});

	it('clamps unusable page and limit instead of answering 400', async () => {
		await makeOrder();

		const res = await list({ page: '-5', limit: '9999' });
		const junk = await list({ page: 'abc', limit: '0' });

		expect(res.status).toBe(200);
		expect(res.body.meta).toMatchObject({ page: 1, limit: 100 });
		expect(junk.status).toBe(200);
		expect(junk.body.meta).toMatchObject({ page: 1, limit: 20 });
	});

	it('walks every order exactly once when all rows share the sort key', async () => {
		// Identical createdAt: only the id tie-break keeps page boundaries stable.
		const sameInstant = new Date('2026-01-01T00:00:00.000Z');
		const created = [];
		for (let i = 0; i < 7; i += 1) created.push(await makeOrder({ createdAt: sameInstant }));

		const seen = [];
		const first = await list({ page: 1, limit: 3 });
		for (let page = 1; page <= first.body.meta.totalPages; page += 1) {
			const res = page === 1 ? first : await list({ page, limit: 3 });
			seen.push(...res.body.data.map((order) => order._id));
		}

		expect(first.body.meta.totalPages).toBe(3);
		// Ties sort by descending id, so the walk is the ids in reverse order;
		// without the id tie-break the order is whatever the engine happens to return.
		expect(seen).toEqual(created.map((order) => String(order._id)).sort().reverse());
	});

	it('never lists the admin-only edit history', async () => {
		await makeOrder();

		const res = await list();

		expect(res.body.data[0]).not.toHaveProperty('itemsHistory');
	});
});

describe('GET /api/seller/orders — product details on each line', () => {
	it('attaches name and image of the product and null for one that no longer exists', async () => {
		const app = buildTestApp();
		const { cookies } = await makeAdminSession(app);
		const product = await makeProduct({ name: 'Lanyard', imageUrl: '/l.png', category: 'neck', price: 3000 });
		const vanished = await makeProduct({ name: 'Vanished', price: 100 });
		await makeOrder({
			items: [
				{ productId: product._id, productName: 'Lanyard', price: 3000, quantity: 1 },
				{ productId: vanished._id, productName: 'Vanished', price: 100, quantity: 1 }
			],
			totalAmount: 3100
		});
		await deleteProduct(vanished._id);

		const res = await request(app).get('/api/seller/orders').set('Cookie', cookies);

		expect(res.body.data[0].items.map((item) => item.productId)).toEqual([
			{ _id: String(product._id), name: 'Lanyard', price: 3000, imageUrl: '/l.png', category: 'neck' },
			null
		]);
	});
});
