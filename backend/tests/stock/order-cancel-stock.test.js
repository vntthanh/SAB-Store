/**
 * Cancel/un-cancel stock accounting — Vấn đề 3, 4, 6 from the phase spec.
 *
 * Covers both routes that can transition an order's status:
 *   - PUT /api/admin/orders/:id  (admin)
 *   - PUT /api/seller/orders/:id/status  (seller — the route the POS UI
 *     (DirectSalesPage) actually calls to cancel a direct sale)
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');
const Product = require('../../models/Product');
const Order = require('../../models/Order');

async function makeWebOrder(overrides = {}) {
	const product = await makeProduct({ stockQuantity: 10 });
	const n = Math.floor(Math.random() * 1e8); // 8 digits max: "W" + 8 digits = 9 chars, under the 10-char orderCode limit
	const order = await Order.create({
		orderCode: `W${n}`,
		studentId: `SV${n}`,
		fullName: 'Web Buyer',
		email: `buyer${n}@test.vn`, // TLD must be 2-3 chars per the schema's email regex
		phoneNumber: '0912345678',
		items: [{ productId: product._id, productName: product.name, price: product.price, quantity: 2 }],
		totalAmount: product.price * 2,
		status: 'confirmed',
		isDirectSale: false,
		stockDeducted: false, // web orders never deduct stock at creation (Q1)
		statusHistory: [{ status: 'confirmed', updatedBy: 'system', updatedAt: new Date() }],
		...overrides
	});
	return { order, product };
}

async function makeDirectSaleOrder(overrides = {}) {
	const product = await makeProduct({ stockQuantity: 10 });
	const n = Math.floor(Math.random() * 1e9);
	// Simulate a direct sale that already deducted stock at creation, the way
	// both direct-sale routes do.
	await Product.updateOne({ _id: product._id }, { $inc: { stockQuantity: -2 } });
	const order = await Order.create({
		orderCode: `D${n}`,
		fullName: `NB: seller`,
		items: [{ productId: product._id, productName: product.name, price: product.price, quantity: 2 }],
		totalAmount: product.price * 2,
		status: 'paid',
		isDirectSale: true,
		stockDeducted: true,
		statusHistory: [{ status: 'paid', updatedBy: 'seller', updatedAt: new Date() }],
		...overrides
	});
	return { order, product };
}

describe('Admin PUT /api/admin/orders/:id — stock accounting', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	it('cancelling a web order (never deducted stock) does not inflate stock', async () => {
		const { order, product } = await makeWebOrder();
		const before = (await Product.findById(product._id)).stockQuantity;

		const res = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', cookies)
			.send({ status: 'cancelled', cancelReason: 'test' });

		expect(res.status).toBe(200);
		const after = await Product.findById(product._id);
		expect(after.stockQuantity).toBe(before);
	});

	it('cancelling a direct-sale order restores stock exactly once', async () => {
		const { order, product } = await makeDirectSaleOrder();
		const before = (await Product.findById(product._id)).stockQuantity;

		const res = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', cookies)
			.send({ status: 'cancelled', cancelReason: 'test' });

		expect(res.status).toBe(200);
		const after = await Product.findById(product._id);
		expect(after.stockQuantity).toBe(before + 2);

		const saved = await Order.findById(order._id);
		expect(saved.stockDeducted).toBe(false);
	});

	it('two concurrent cancels of the same order: exactly one succeeds (200), the other gets 409, stock restored exactly once', async () => {
		const { order, product } = await makeDirectSaleOrder();
		const before = (await Product.findById(product._id)).stockQuantity;

		const [r1, r2] = await Promise.all([
			request(app).put(`/api/admin/orders/${order._id}`).set('Cookie', cookies).send({ status: 'cancelled', cancelReason: 'a' }),
			request(app).put(`/api/admin/orders/${order._id}`).set('Cookie', cookies).send({ status: 'cancelled', cancelReason: 'b' })
		]);

		const statuses = [r1.status, r2.status].sort();
		expect(statuses).toEqual([200, 409]);

		const after = await Product.findById(product._id);
		expect(after.stockQuantity).toBe(before + 2); // restored exactly once, not twice
	});

	it('un-cancelling a direct-sale order re-deducts stock', async () => {
		const { order, product } = await makeDirectSaleOrder({ status: 'cancelled', stockDeducted: false });
		// simulate that stock was already restored when it was cancelled
		await Product.updateOne({ _id: product._id }, { $inc: { stockQuantity: 2 } });
		const before = (await Product.findById(product._id)).stockQuantity;

		const res = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', cookies)
			.send({ status: 'confirmed' });

		expect(res.status).toBe(200);
		const after = await Product.findById(product._id);
		expect(after.stockQuantity).toBe(before - 2);

		const saved = await Order.findById(order._id);
		expect(saved.stockDeducted).toBe(true);
	});

	it('un-cancelling a direct-sale order rejects when stock is no longer sufficient, and status stays cancelled', async () => {
		const { order, product } = await makeDirectSaleOrder({ status: 'cancelled', stockDeducted: false });
		await Product.updateOne({ _id: product._id }, { $set: { stockQuantity: 1 } }); // not enough to restore 2

		const res = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', cookies)
			.send({ status: 'confirmed' });

		expect(res.status).toBe(400);

		const saved = await Order.findById(order._id);
		expect(saved.status).toBe('cancelled'); // rolled back, transition did not commit
		expect(saved.stockDeducted).toBe(false);
	});

	it('un-cancelling a web order never deducts stock', async () => {
		const { order, product } = await makeWebOrder({ status: 'cancelled' });
		const before = (await Product.findById(product._id)).stockQuantity;

		const res = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', cookies)
			.send({ status: 'confirmed' });

		expect(res.status).toBe(200);
		const after = await Product.findById(product._id);
		expect(after.stockQuantity).toBe(before);
	});

	it('writes exactly one statusHistory entry per transition (no duplicate from a pre-save hook)', async () => {
		const { order } = await makeWebOrder();
		const historyBefore = order.statusHistory.length;

		const res = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', cookies)
			.send({ status: 'paid', transactionCode: 'TX1' });

		expect(res.status).toBe(200);
		const saved = await Order.findById(order._id);
		expect(saved.statusHistory.length).toBe(historyBefore + 1);
	});

	// F5 — a hard-deleted product used to make a past direct-sale order
	// permanently un-cancellable: restore → PRODUCT_NOT_FOUND →
	// applyStatusTransitionStockEffect's catch reverted the status → 500,
	// forever, on every future cancel attempt. Deleting is a real feature
	// (DELETE /api/admin/products/:id), so this is reachable in production.
	it('cancelling a direct-sale order whose product was hard-deleted still succeeds', async () => {
		const { order, product } = await makeDirectSaleOrder();
		await Product.deleteOne({ _id: product._id });

		const res = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', cookies)
			.send({ status: 'cancelled', cancelReason: 'product deleted after sale' });

		expect(res.status).toBe(200);

		const saved = await Order.findById(order._id);
		expect(saved.status).toBe('cancelled');
		// Nothing to restore — the flag still flips, there is just no stock
		// mutation for this line.
		expect(saved.stockDeducted).toBe(false);
	});
});

describe('Seller PUT /api/seller/orders/:id/status — stock accounting (the route the POS UI actually calls)', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app)); // admin role passes authenticateSeller too
	});

	it('cancelling a direct-sale order via the seller route restores stock', async () => {
		const { order, product } = await makeDirectSaleOrder();
		const before = (await Product.findById(product._id)).stockQuantity;

		const res = await request(app)
			.put(`/api/seller/orders/${order._id}/status`)
			.set('Cookie', cookies)
			.send({ status: 'cancelled', cancelReason: 'Hủy tại quầy' });

		expect(res.status).toBe(200);
		const after = await Product.findById(product._id);
		expect(after.stockQuantity).toBe(before + 2);
	});

	it('cancelling a web order via the seller route does not inflate stock', async () => {
		const { order, product } = await makeWebOrder();
		const before = (await Product.findById(product._id)).stockQuantity;

		const res = await request(app)
			.put(`/api/seller/orders/${order._id}/status`)
			.set('Cookie', cookies)
			.send({ status: 'cancelled', cancelReason: 'test' });

		expect(res.status).toBe(200);
		const after = await Product.findById(product._id);
		expect(after.stockQuantity).toBe(before);
	});

	it('rejects the legacy "pending" status', async () => {
		const { order } = await makeWebOrder();
		const res = await request(app)
			.put(`/api/seller/orders/${order._id}/status`)
			.set('Cookie', cookies)
			.send({ status: 'pending' });

		expect(res.status).toBe(400);
	});

	// F9 — this route had no validateOrderUpdate (admin's identical route
	// does). Mongoose 8 does reject the over-length note at the schema level
	// (empirically verified), but this route's catch-all turned that
	// ValidationError into an opaque 500 instead of a clean 400 — asserted
	// here as a 400 with no oversized note left in statusHistory.
	it('rejects a note over 500 characters instead of pushing it unbounded into statusHistory', async () => {
		const { order } = await makeWebOrder();
		const res = await request(app)
			.put(`/api/seller/orders/${order._id}/status`)
			.set('Cookie', cookies)
			.send({ status: 'paid', transactionCode: 'TX1', note: 'x'.repeat(501) });

		expect(res.status).toBe(400);

		const saved = await Order.findById(order._id);
		expect(saved.status).toBe('confirmed'); // transition never committed
		expect(saved.statusHistory.some((h) => h.note && h.note.length > 500)).toBe(false);
	});
});
