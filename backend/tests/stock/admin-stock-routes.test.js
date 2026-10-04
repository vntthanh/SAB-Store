const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');
const Product = require('../../models/Product');
const StockMovement = require('../../models/StockMovement');
const { recordMovement, applyMovement } = require('../../services/stock-ledger');

describe('admin stock routes', () => {
	let app;
	let cookies;

	beforeAll(async () => {
		await StockMovement.init();
	});

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	const post = (id, body) => request(app).post(`/api/admin/products/${id}/stock-adjustments`).set('Cookie', cookies).send(body);

	describe('authentication', () => {
		it.each([
			['post', '/api/admin/products/507f1f77bcf86cd799439011/stock-adjustments'],
			['get', '/api/admin/products/507f1f77bcf86cd799439011/stock-movements'],
			['get', '/api/admin/stock/reconcile']
		])('%s %s is refused without a session', async (method, url) => {
			const res = await request(app)[method](url).send({ mode: 'delta', value: 1, reason: 'x' });
			expect(res.status).toBe(401);
		});
	});

	describe('POST /products/:id/stock-adjustments', () => {
		it('records a delta adjustment as a pending movement and answers 202 without changing the cache', async () => {
			const product = await makeProduct({ stockQuantity: 5 });

			const res = await post(product._id, { mode: 'delta', value: -2, reason: '  broken  ' });

			expect(res.status).toBe(202);
			expect(res.body.success).toBe(true);
			expect(res.body.data).toMatchObject({ type: 'adjust', delta: -2, status: 'pending', reason: 'broken' });
			const stored = await StockMovement.findById(res.body.data._id).lean();
			expect(stored).toMatchObject({ type: 'adjust', delta: -2, status: 'pending' });
			expect(stored.createdBy).toMatch(/@test\.local$/);
			expect((await Product.findById(product._id)).stockQuantity).toBe(5);
		});

		it('records target mode as set_target with the delta left for the worker', async () => {
			const product = await makeProduct({ stockQuantity: 5 });

			const res = await post(product._id, { mode: 'target', value: 0, reason: 'recount' });

			expect(res.status).toBe(202);
			expect(await StockMovement.findById(res.body.data._id).lean()).toMatchObject({ type: 'set_target', target: 0, delta: null });
		});

		it('records two identical requests as two adjustments', async () => {
			const product = await makeProduct();
			await post(product._id, { mode: 'delta', value: 1, reason: 'a' });
			await post(product._id, { mode: 'delta', value: 1, reason: 'a' });

			expect(await StockMovement.countDocuments({ productId: product._id })).toBe(2);
		});

		it.each([
			['unknown mode', { mode: 'add', value: 1, reason: 'r' }],
			['missing mode', { value: 1, reason: 'r' }],
			['string value', { mode: 'delta', value: '5', reason: 'r' }],
			['fractional value', { mode: 'delta', value: 1.5, reason: 'r' }],
			['null value', { mode: 'delta', value: null, reason: 'r' }],
			['absurd value', { mode: 'delta', value: 1e12, reason: 'r' }],
			['zero delta', { mode: 'delta', value: 0, reason: 'r' }],
			['negative target', { mode: 'target', value: -1, reason: 'r' }],
			['missing reason', { mode: 'delta', value: 1 }],
			['blank reason', { mode: 'delta', value: 1, reason: '   ' }],
			['reason over 200 characters', { mode: 'delta', value: 1, reason: 'x'.repeat(201) }],
			['object reason', { mode: 'delta', value: 1, reason: { $ne: null } }]
		])('answers 400 for %s and records nothing', async (_name, body) => {
			const product = await makeProduct();

			const res = await post(product._id, body);

			expect(res.status).toBe(400);
			expect(res.body).toMatchObject({ success: false, code: 'STOCK_ADJUSTMENT_INVALID' });
			expect(await StockMovement.countDocuments({})).toBe(0);
		});

		it('answers 400 for a malformed product id and 404 for an unknown one', async () => {
			expect((await post('not-an-id', { mode: 'delta', value: 1, reason: 'r' })).status).toBe(400);
			expect((await post('507f1f77bcf86cd799439011', { mode: 'delta', value: 1, reason: 'r' })).status).toBe(404);
			expect(await StockMovement.countDocuments({})).toBe(0);
		});
	});

	describe('GET /products/:id/stock-movements', () => {
		it('pages the history newest first with the documented fields only', async () => {
			const product = await makeProduct();
			const other = await makeProduct();
			for (let i = 1; i <= 3; i++) {
				await recordMovement({ productId: product._id, type: 'adjust', delta: i, idempotencyKey: `h-${i}`, reason: `r${i}` });
			}
			await recordMovement({ productId: other._id, type: 'adjust', delta: 99, idempotencyKey: 'other' });

			const res = await request(app).get(`/api/admin/products/${product._id}/stock-movements?page=1&limit=2`).set('Cookie', cookies);

			expect(res.status).toBe(200);
			expect(res.body.data.items.map((m) => m.delta)).toEqual([3, 2]);
			expect(res.body.data.pagination).toEqual({ page: 1, pages: 2, total: 3, limit: 2 });
			expect(Object.keys(res.body.data.items[0]).sort()).toEqual(
				['_id', 'appliedAt', 'createdAt', 'createdBy', 'delta', 'orderId', 'reason', 'status', 'stockAfter', 'target', 'type'].sort()
			);

			const page2 = await request(app).get(`/api/admin/products/${product._id}/stock-movements?page=2&limit=2`).set('Cookie', cookies);
			expect(page2.body.data.items.map((m) => m.delta)).toEqual([1]);
		});

		it('answers 400 for a malformed id and ignores operator-shaped paging input', async () => {
			expect((await request(app).get('/api/admin/products/zzz/stock-movements').set('Cookie', cookies)).status).toBe(400);
			const product = await makeProduct();
			const res = await request(app).get(`/api/admin/products/${product._id}/stock-movements?page[$gt]=1&limit[$ne]=0`).set('Cookie', cookies);
			expect(res.status).toBe(200);
		});
	});

	describe('GET /stock/reconcile', () => {
		it('lists a product whose cache was edited by hand', async () => {
			const product = await makeProduct({ stockQuantity: 0 });
			const m = await recordMovement({ productId: product._id, type: 'adjust', delta: 4, idempotencyKey: 'rec-1' });
			await applyMovement(m._id);
			await Product.updateOne({ _id: product._id }, { $set: { stockQuantity: 9 } });

			const res = await request(app).get('/api/admin/stock/reconcile').set('Cookie', cookies);

			expect(res.status).toBe(200);
			expect(res.body.data).toEqual([{ productId: String(product._id), name: product.name, cached: 9, ledgerSum: 4, diff: 5, pending: 0 }]);
		});
	});

	describe('GET /products', () => {
		it('reports pendingMovements per product', async () => {
			const busy = await makeProduct({ stockQuantity: 0 });
			const quiet = await makeProduct({ stockQuantity: 0 });
			await recordMovement({ productId: busy._id, type: 'adjust', delta: 1, idempotencyKey: 'p-1' });
			const applied = await recordMovement({ productId: busy._id, type: 'adjust', delta: 1, idempotencyKey: 'p-2' });
			await StockMovement.updateOne({ _id: applied._id }, { $set: { status: 'applied' } });

			const res = await request(app).get('/api/admin/products').set('Cookie', cookies);

			const byId = new Map(res.body.data.products.map((p) => [p._id, p]));
			expect(byId.get(String(busy._id)).pendingMovements).toBe(1);
			expect(byId.get(String(quiet._id)).pendingMovements).toBe(0);
			expect(byId.get(String(busy._id)).name).toBe(busy.name);
		});
	});

	describe('product create and update', () => {
		it('creating with stockQuantity records an applied opening movement', async () => {
			const res = await request(app).post('/api/admin/products').set('Cookie', cookies)
				.send({ name: 'Opened', price: 1000, category: 'general', stockQuantity: 12 });

			expect(res.status).toBe(201);
			const id = res.body.data.product._id;
			expect((await Product.findById(id)).stockQuantity).toBe(12);
			expect(await StockMovement.find({ productId: id }).lean()).toEqual([
				expect.objectContaining({ type: 'opening', delta: 12, status: 'applied', stockAfter: 12 })
			]);
			const report = await request(app).get('/api/admin/stock/reconcile').set('Cookie', cookies);
			expect(report.body.data).toEqual([]);
		});

		it('creating without stock records no movement', async () => {
			const res = await request(app).post('/api/admin/products').set('Cookie', cookies)
				.send({ name: 'Empty', price: 1000, category: 'general' });

			expect(res.status).toBe(201);
			expect(await StockMovement.countDocuments({})).toBe(0);
		});

		it('a failed create leaves neither a product nor a movement', async () => {
			const res = await request(app).post('/api/admin/products').set('Cookie', cookies)
				.send({ name: 'x'.repeat(101), price: 1000, category: 'general', stockQuantity: 5 });

			expect(res.status).toBe(400);
			expect(await Product.countDocuments({})).toBe(0);
			expect(await StockMovement.countDocuments({})).toBe(0);
		});

		it('PUT ignores stockQuantity but still applies other fields', async () => {
			const product = await makeProduct({ stockQuantity: 50, name: 'Before' });

			const res = await request(app).put(`/api/admin/products/${product._id}`).set('Cookie', cookies)
				.send({ name: 'After', stockQuantity: 999 });

			expect(res.status).toBe(200);
			const stored = await Product.findById(product._id);
			expect(stored.name).toBe('After');
			expect(stored.stockQuantity).toBe(50);
			expect(await StockMovement.countDocuments({})).toBe(0);
		});
	});
});
