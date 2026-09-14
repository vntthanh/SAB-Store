/**
 * Admin product routes — stockQuantity handling (user decision, this phase):
 *   - POST accepts stockQuantity as the initial absolute value.
 *   - PUT never writes it absolutely; it applies a guarded delta so
 *     concurrent edits compose instead of last-write-wins, and stock can
 *     never go negative.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');
const Product = require('../../models/Product');

describe('POST /api/admin/products — initial stockQuantity', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	it('stores the provided stockQuantity', async () => {
		const res = await request(app)
			.post('/api/admin/products')
			.set('Cookie', cookies)
			.send({ name: 'New Product', price: 10000, category: 'general', stockQuantity: 50 });

		expect(res.status).toBe(201);
		expect(res.body.data.product.stockQuantity).toBe(50);
	});

	it('defaults to 0 when stockQuantity is omitted', async () => {
		const res = await request(app)
			.post('/api/admin/products')
			.set('Cookie', cookies)
			.send({ name: 'New Product', price: 10000, category: 'general' });

		expect(res.status).toBe(201);
		expect(res.body.data.product.stockQuantity).toBe(0);
	});

	it('rejects a negative stockQuantity', async () => {
		const res = await request(app)
			.post('/api/admin/products')
			.set('Cookie', cookies)
			.send({ name: 'New Product', price: 10000, category: 'general', stockQuantity: -5 });

		expect(res.status).toBe(400);
	});
});

describe('PUT /api/admin/products/:id — guarded delta', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	it('applies +10 as a delta: 50 -> 60', async () => {
		const product = await makeProduct({ stockQuantity: 50 });

		const res = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ stockQuantity: 60 });

		expect(res.status).toBe(200);
		expect(res.body.data.product.stockQuantity).toBe(60);
		expect((await Product.findById(product._id)).stockQuantity).toBe(60);
	});

	it('applies a decrease as a delta: 50 -> 30', async () => {
		const product = await makeProduct({ stockQuantity: 50 });

		const res = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ stockQuantity: 30 });

		expect(res.status).toBe(200);
		expect((await Product.findById(product._id)).stockQuantity).toBe(30);
	});

	it('rejects a decrease that would take stock below 0', async () => {
		const product = await makeProduct({ stockQuantity: 5 });

		const res = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ stockQuantity: -1 });

		expect(res.status).toBe(400);
	});

	it('leaves stock untouched when stockQuantity is omitted', async () => {
		const product = await makeProduct({ stockQuantity: 50 });

		const res = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ name: 'Renamed' });

		expect(res.status).toBe(200);
		expect((await Product.findById(product._id)).stockQuantity).toBe(50);
	});

	it('two concurrent admins each requesting +10 (50 -> 60) compose to +20, not last-write-wins', async () => {
		const product = await makeProduct({ stockQuantity: 50 });

		// Force both requests' baseline read to land before either one's write
		// commits — the way two admins clicking "save" within the same instant
		// would race at the database level. Two supertest requests fired via
		// Promise.all through the same in-process Express app otherwise tend to
		// resolve close to sequentially (no real network jitter between them),
		// so without this the second request's read would already see the
		// first request's write and the test would not exercise the race at all.
		const originalFindById = Product.findById.bind(Product);
		const spy = jest.spyOn(Product, 'findById').mockImplementation(async (...args) => {
			const doc = await originalFindById(...args);
			await new Promise((resolve) => setTimeout(resolve, 25));
			return doc;
		});

		let r1, r2;
		try {
			[r1, r2] = await Promise.all([
				request(app).put(`/api/admin/products/${product._id}`).set('Cookie', cookies).send({ stockQuantity: 60 }),
				request(app).put(`/api/admin/products/${product._id}`).set('Cookie', cookies).send({ stockQuantity: 60 })
			]);
		} finally {
			spy.mockRestore();
		}

		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);

		const final = await Product.findById(product._id);
		expect(final.stockQuantity).toBe(70); // 50 + 10 + 10, composed — proves the guarded $inc, not the
		// last-write-wins absolute write the route used to perform
	});

	// F7 — findByIdAndUpdate(updateData) used to run BEFORE the guarded stock
	// $inc, so when the stock delta was rejected as INSUFFICIENT_STOCK,
	// name/price/etc had already been committed while the response was a 400
	// — a partially-applied edit on a request the admin was told failed.
	//
	// INSUFFICIENT_STOCK only fires when the *actual current* stock (at the
	// instant adjustStock's atomic filter runs) can no longer satisfy the
	// delta computed from this request's own (now stale) read of `existing`
	// — a plain negative target is rejected earlier, before either write, by
	// isValidStockQuantity's absolute-value check, so it can't exercise this
	// path. A concurrent sale draining stock between this request's read and
	// its own stock write is simulated the same way the "compose, not
	// last-write-wins" test above does.
	it('rejects the whole request and writes nothing when a concurrent sale makes the stock delta invalid, even with other fields present', async () => {
		const product = await makeProduct({ stockQuantity: 5, name: 'Original Name', price: 10000 });

		const originalFindById = Product.findById.bind(Product);
		const spy = jest.spyOn(Product, 'findById').mockImplementation(async (...args) => {
			const doc = await originalFindById(...args);
			// Simulate another sale draining stock to 0 between this
			// request's read of `existing` and its own guarded $inc.
			await Product.updateOne({ _id: product._id }, { $set: { stockQuantity: 0 } });
			return doc;
		});

		let res;
		try {
			res = await request(app)
				.put(`/api/admin/products/${product._id}`)
				.set('Cookie', cookies)
				.send({ name: 'Renamed During Failed Edit', price: 99999, stockQuantity: 3 }); // delta computed as -2
		} finally {
			spy.mockRestore();
		}

		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/dưới 0/);

		const stored = await Product.findById(product._id);
		expect(stored.name).toBe('Original Name');
		expect(stored.price).toBe(10000);
	});
});
