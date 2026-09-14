/**
 * Q2 — admin POST /orders/direct.
 *
 * Before this phase the route always threw a CastError on `order.save()`
 * (`createdBy: req.admin.username`, a String, assigned to an ObjectId schema
 * path) and never persisted a single order. These tests prove the route now
 * actually creates orders, deducts stock atomically, and never oversells.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');
const Product = require('../../models/Product');
const Order = require('../../models/Order');

describe('POST /api/admin/orders/direct', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	it('creates an order successfully (no CastError) and stores a real ObjectId createdBy', async () => {
		const product = await makeProduct({ stockQuantity: 10, price: 20000 });

		const res = await request(app)
			.post('/api/admin/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [{ productId: String(product._id), quantity: 2 }] });

		expect(res.status).toBe(201);
		expect(res.body.success).toBe(true);
		expect(res.body.data.totalAmount).toBe(40000);

		const saved = await Order.findOne({ orderCode: res.body.data.orderCode });
		expect(saved).not.toBeNull();
		expect(saved.createdBy).not.toBeNull();
		expect(saved.isDirectSale).toBe(true);
		expect(saved.status).toBe('paid');
	});

	it('deducts stock atomically and marks stockDeducted true', async () => {
		const product = await makeProduct({ stockQuantity: 5, price: 10000 });

		const res = await request(app)
			.post('/api/admin/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [{ productId: String(product._id), quantity: 3 }] });

		expect(res.status).toBe(201);
		expect((await Product.findById(product._id)).stockQuantity).toBe(2);

		const saved = await Order.findOne({ orderCode: res.body.data.orderCode });
		expect(saved.stockDeducted).toBe(true);
	});

	it('rejects an order for a product with insufficient stock and deducts nothing', async () => {
		const product = await makeProduct({ stockQuantity: 1, price: 10000 });

		const res = await request(app)
			.post('/api/admin/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [{ productId: String(product._id), quantity: 5 }] });

		expect(res.status).toBe(400);
		expect((await Product.findById(product._id)).stockQuantity).toBe(1);
	});

	it('rejects an empty item list', async () => {
		const res = await request(app)
			.post('/api/admin/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [] });

		expect(res.status).toBe(400);
	});

	it('rejects a product that is not active/available', async () => {
		const product = await makeProduct({ stockQuantity: 10, isActive: false });

		const res = await request(app)
			.post('/api/admin/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [{ productId: String(product._id), quantity: 1 }] });

		expect(res.status).toBe(400);
	});

	it('mid-loop failure across two items leaves the first item un-deducted (compensated)', async () => {
		const ok = await makeProduct({ stockQuantity: 10, price: 10000 });
		const short = await makeProduct({ stockQuantity: 1, price: 10000 });

		const res = await request(app)
			.post('/api/admin/orders/direct')
			.set('Cookie', cookies)
			.send({
				items: [
					{ productId: String(ok._id), quantity: 2 },
					{ productId: String(short._id), quantity: 5 }
				]
			});

		expect(res.status).toBe(400);
		expect((await Product.findById(ok._id)).stockQuantity).toBe(10);
		expect((await Product.findById(short._id)).stockQuantity).toBe(1);

		const anyOrder = await Order.findOne({});
		expect(anyOrder).toBeNull();
	});
});
