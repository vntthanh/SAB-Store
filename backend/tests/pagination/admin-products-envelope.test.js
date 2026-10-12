const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');

// GET /api/admin/products answers { success, data, meta }. This replaces the
// earlier { data: { products, pagination: { pages } } } body on purpose: it is
// the shared list envelope, and `meta.totalPages` is 0 (not 1) for no rows.
describe('GET /api/admin/products — list envelope', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	const list = (query = {}) => request(app).get('/api/admin/products').query(query).set('Cookie', cookies);

	it('answers data as an array of rows and meta with page, limit, total and totalPages', async () => {
		for (let i = 0; i < 5; i += 1) await makeProduct({ name: `Envelope ${i}` });

		const res = await list({ page: 2, limit: 2 });

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data).toHaveLength(2);
		expect(res.body.data[0]).toEqual(expect.objectContaining({ name: expect.any(String), pendingMovements: 0 }));
		expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
	});

	it('returns the short last page and an empty page past the end', async () => {
		for (let i = 0; i < 5; i += 1) await makeProduct();

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
		await makeProduct({ name: 'Match A', category: 'pins' });
		await makeProduct({ name: 'Match B', category: 'pins' });
		await makeProduct({ name: 'Other', category: 'cards' });

		const res = await list({ category: 'pins', limit: 1 });

		expect(res.body.meta).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
	});

	it('clamps unusable page and limit instead of answering 400', async () => {
		await makeProduct();

		const res = await list({ page: '-5', limit: '9999' });
		const junk = await list({ page: 'abc', limit: '0' });

		expect(res.status).toBe(200);
		expect(res.body.meta).toMatchObject({ page: 1, limit: 100 });
		expect(junk.status).toBe(200);
		expect(junk.body.meta).toMatchObject({ page: 1, limit: 20 });
	});

	it('walks every row exactly once when all rows share the sort key', async () => {
		// Identical createdAt: only the id tie-break keeps page boundaries stable.
		const sameInstant = new Date('2026-01-01T00:00:00.000Z');
		const created = [];
		for (let i = 0; i < 7; i += 1) created.push(await makeProduct({ name: `Tied ${i}`, createdAt: sameInstant }));

		const seen = [];
		const first = await list({ page: 1, limit: 3 });
		for (let page = 1; page <= first.body.meta.totalPages; page += 1) {
			const res = page === 1 ? first : await list({ page, limit: 3 });
			seen.push(...res.body.data.map((p) => p._id));
		}

		expect(first.body.meta.totalPages).toBe(3);
		// Ties sort by descending id, so the walk is the ids in reverse order;
		// without the id tie-break the order is whatever the engine happens to return.
		expect(seen).toEqual(created.map((p) => String(p._id)).sort().reverse());
	});
});
