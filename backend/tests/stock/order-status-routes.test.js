/**
 * Order status routes, apart from stock: what they record and what they reject.
 * The stock side of cancelling and un-cancelling (movements, `stockDeducted`,
 * legacy orders) is covered in order-stock-ledger.test.js.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');
const Order = require('../../models/Order');

async function makeWebOrder(overrides = {}) {
	const product = await makeProduct({ stockQuantity: 10 });
	const n = Math.floor(Math.random() * 1e8); // 8 digits max: "W" + 8 digits = 9 chars, under the 10-char orderCode limit
	return Order.create({
		orderCode: `W${n}`,
		studentId: `SV${n}`,
		fullName: 'Web Buyer',
		email: `buyer${n}@test.vn`, // TLD must be 2-3 chars per the schema's email regex
		phoneNumber: '0912345678',
		items: [{ productId: product._id, productName: product.name, price: product.price, quantity: 2 }],
		totalAmount: product.price * 2,
		status: 'confirmed',
		isDirectSale: false,
		stockDeducted: true,
		statusHistory: [{ status: 'confirmed', updatedBy: 'system', updatedAt: new Date() }],
		...overrides
	});
}

describe('Admin PUT /api/admin/orders/:id', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	it('writes exactly one statusHistory entry per transition (no duplicate from a pre-save hook)', async () => {
		const order = await makeWebOrder();
		const historyBefore = order.statusHistory.length;

		const res = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', cookies)
			.send({ status: 'paid', transactionCode: 'TX1' });

		expect(res.status).toBe(200);
		const saved = await Order.findById(order._id);
		expect(saved.statusHistory.length).toBe(historyBefore + 1);
	});

	it('answers 404 for an order that does not exist', async () => {
		const res = await request(app)
			.put('/api/admin/orders/64b000000000000000000000')
			.set('Cookie', cookies)
			.send({ status: 'paid' });

		expect(res.status).toBe(404);
	});

	it('answers 409 for a change to the status the order already has', async () => {
		const order = await makeWebOrder({ status: 'paid' });

		const res = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', cookies)
			.send({ status: 'paid' });

		expect(res.status).toBe(409);
	});
});

describe('Seller PUT /api/seller/orders/:id/status', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app)); // admin role passes authenticateSeller too
	});

	it('returns the order with its products populated', async () => {
		const order = await makeWebOrder();

		const res = await request(app)
			.put(`/api/seller/orders/${order._id}/status`)
			.set('Cookie', cookies)
			.send({ status: 'paid', transactionCode: 'TX1' });

		expect(res.status).toBe(200);
		expect(res.body.data.order.status).toBe('paid');
		expect(res.body.data.order.items[0].productId).toHaveProperty('name');
	});

	it('rejects the legacy "pending" status', async () => {
		const order = await makeWebOrder();
		const res = await request(app)
			.put(`/api/seller/orders/${order._id}/status`)
			.set('Cookie', cookies)
			.send({ status: 'pending' });

		expect(res.status).toBe(400);
	});

	// An over-length note is a 400, not a 500, and nothing of it is stored.
	it('rejects a note over 500 characters instead of pushing it unbounded into statusHistory', async () => {
		const order = await makeWebOrder();
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
