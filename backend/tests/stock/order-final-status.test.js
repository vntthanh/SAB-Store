/**
 * Cancelled and delivered orders are final: no route changes their status
 * again, and only notes stay editable. Every assertion re-reads MongoDB.
 */
const { randomUUID } = require('crypto');
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');
const { applyPendingMovements } = require('../helpers/stock');
const Order = require('../../models/Order');
const User = require('../../models/User');
const StockMovement = require('../../models/StockMovement');
const { recordMovement } = require('../../services/stock-ledger');

const customer = {
	studentId: '24120001',
	fullName: 'Nguyen Van A',
	email: 'a@example.com',
	phoneNumber: '0987654321'
};

const FINAL_MESSAGE = 'Đơn đã ở trạng thái cuối, chỉ sửa được ghi chú';

let app;
let admin;

beforeAll(async () => {
	await Promise.all([Order.init(), StockMovement.init()]);
	app = buildTestApp();
});

beforeEach(async () => {
	admin = await makeAdminSession(app);
});

async function placeOrder(quantity = 2, price = 10000) {
	const product = await makeProduct({ stockQuantity: 10, price });
	const res = await request(app)
		.post('/api/orders')
		.send({ ...customer, items: [{ productId: String(product._id), quantity }], expectedTotal: price * quantity });
	expect(res.status).toBe(201);
	const order = await Order.findOne({ orderCode: res.body.data.orderCode });
	await applyPendingMovements();
	return { order, product };
}

const movementCount = (product) => StockMovement.countDocuments({ productId: product._id });

async function makeSellerSession() {
	const email = `seller-${randomUUID()}@test.local`;
	const password = 'factory-test-password-1';
	const signUp = await request(app)
		.post('/api/auth/sign-up/email')
		.send({ email, password, name: 'Seller', username: `seller_${randomUUID().slice(0, 8)}` });
	expect(signUp.status).toBe(200);
	await User.updateOne({ email }, { $set: { role: 'seller' } });
	const signIn = await request(app).post('/api/auth/sign-in/email').send({ email, password });
	expect(signIn.status).toBe(200);
	return signIn.headers['set-cookie'];
}

describe.each([
	['admin route', (id) => `/api/admin/orders/${id}`],
	['seller route (admin session)', (id) => `/api/seller/orders/${id}/status`]
])('%s status change on final orders', (_who, urlFor) => {
	const change = (id, body) => request(app).put(urlFor(id)).set('Cookie', admin.cookies).send(body);

	it.each(['confirmed', 'paid', 'delivered'])('refuses cancelled -> %s and writes nothing', async (target) => {
		const { order, product } = await placeOrder();
		expect((await change(order._id, { status: 'cancelled', cancelReason: 'x' })).status).toBe(200);
		await applyPendingMovements();
		const before = await Order.findById(order._id).lean();
		const movementsBefore = await movementCount(product);

		const res = await change(order._id, { status: target });

		expect(res.status).toBe(409);
		expect(res.body).toMatchObject({ code: 'ORDER_FINAL', message: FINAL_MESSAGE });
		expect(await Order.findById(order._id).lean()).toEqual(before);
		expect(await movementCount(product)).toBe(movementsBefore);
	});

	it('refuses delivered -> cancelled without returning stock', async () => {
		const { order, product } = await placeOrder();
		expect((await change(order._id, { status: 'delivered' })).status).toBe(200);
		const movementsBefore = await movementCount(product);

		const res = await change(order._id, { status: 'cancelled', cancelReason: 'late' });

		expect(res.status).toBe(409);
		expect(res.body.code).toBe('ORDER_FINAL');
		expect(await Order.findById(order._id).lean()).toMatchObject({ status: 'delivered', stockDeducted: true });
		expect(await movementCount(product)).toBe(movementsBefore);
		expect(await StockMovement.countDocuments({ productId: product._id, type: 'order_cancel' })).toBe(0);
	});

	it('answers cancelled -> cancelled with ORDER_FINAL, not "already in this status"', async () => {
		const { order } = await placeOrder();
		expect((await change(order._id, { status: 'cancelled' })).status).toBe(200);

		const res = await change(order._id, { status: 'cancelled' });

		expect(res.status).toBe(409);
		expect(res.body.code).toBe('ORDER_FINAL');
	});

	it('still allows confirmed -> delivered, confirmed -> paid -> delivered and paid -> cancelled', async () => {
		const counter = (await placeOrder()).order;
		expect((await change(counter._id, { status: 'delivered' })).status).toBe(200);

		const web = (await placeOrder()).order;
		expect((await change(web._id, { status: 'paid', transactionCode: 'TX1' })).status).toBe(200);
		expect((await change(web._id, { status: 'delivered' })).status).toBe(200);

		const paid = (await placeOrder()).order;
		expect((await change(paid._id, { status: 'paid' })).status).toBe(200);
		expect((await change(paid._id, { status: 'cancelled', cancelReason: 'x' })).status).toBe(200);

		const statuses = await Promise.all([counter, web, paid].map(async (o) => (await Order.findById(o._id).lean()).status));
		expect(statuses).toEqual(['delivered', 'delivered', 'cancelled']);
	});
});

describe('PATCH /api/admin/orders/:id/notes', () => {
	const patch = (id, body, cookies = admin.cookies) =>
		request(app).patch(`/api/admin/orders/${id}/notes`).set('Cookie', cookies).send(body);

	it('edits the customer note and appends an internal note on a cancelled order without touching status or stock', async () => {
		const { order, product } = await placeOrder();
		await request(app).put(`/api/admin/orders/${order._id}`).set('Cookie', admin.cookies)
			.send({ status: 'cancelled', cancelReason: 'x' });
		await applyPendingMovements();
		const before = await Order.findById(order._id).lean();
		const movementsBefore = await movementCount(product);

		const res = await patch(order._id, { additionalNote: '  giao sau 5h  ', note: 'khách gọi lại' });

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		const after = await Order.findById(order._id).lean();
		expect(after.additionalNote).toBe('giao sau 5h');
		expect(after.internalNotes).toHaveLength(1);
		expect(after.internalNotes[0]).toMatchObject({ note: 'khách gọi lại', by: admin.username });
		expect(after.internalNotes[0].at).toBeInstanceOf(Date);
		expect(after.internalNotes[0]).not.toHaveProperty('_id');
		expect(after.status).toBe('cancelled');
		expect(after.statusHistory).toEqual(before.statusHistory);
		expect(after.stockDeducted).toBe(false);
		expect(await movementCount(product)).toBe(movementsBefore);
	});

	it('appends further internal notes and clears the customer note with an empty string', async () => {
		const { order } = await placeOrder();
		await patch(order._id, { additionalNote: 'abc', note: 'one' });

		const res = await patch(order._id, { additionalNote: '', note: 'two' });

		expect(res.status).toBe(200);
		const after = await Order.findById(order._id).lean();
		expect(after.additionalNote).toBe('');
		expect(after.internalNotes.map((n) => n.note)).toEqual(['one', 'two']);
	});

	it('answers 404 for an order that does not exist', async () => {
		const res = await patch('64b000000000000000000000', { note: 'x' });

		expect(res.status).toBe(404);
	});

	it('rejects an empty body, an empty or oversized note and a malformed id with 400', async () => {
		const { order } = await placeOrder();

		for (const body of [{}, { note: '' }, { note: '   ' }, { note: 'x'.repeat(501) }, { additionalNote: 'x'.repeat(501) }, { status: 'cancelled' }]) {
			const res = await patch(order._id, body);
			expect(res.status).toBe(400);
		}
		expect((await patch('not-an-id', { note: 'x' })).status).toBe(400);

		const after = await Order.findById(order._id).lean();
		expect(after.internalNotes).toHaveLength(0);
		expect(after.status).toBe('confirmed');
	});

	it('ignores fields other than the two notes', async () => {
		const { order } = await placeOrder();
		const before = await Order.findById(order._id).lean();

		const res = await patch(order._id, { note: 'ok', status: 'cancelled', totalAmount: 1, stockDeducted: false });

		expect(res.status).toBe(200);
		const after = await Order.findById(order._id).lean();
		expect(after).toMatchObject({ status: before.status, totalAmount: before.totalAmount, stockDeducted: true });
		expect(after.internalNotes).toHaveLength(1);
	});

	it('refuses a seller with 403 and an anonymous caller with 401', async () => {
		const { order } = await placeOrder();
		const sellerCookies = await makeSellerSession();

		expect((await patch(order._id, { note: 'x' }, sellerCookies)).status).toBe(403);
		expect((await request(app).patch(`/api/admin/orders/${order._id}/notes`).send({ note: 'x' })).status).toBe(401);
		expect((await Order.findById(order._id).lean()).internalNotes).toHaveLength(0);
	});
});

describe('internal notes stay admin-only', () => {
	it('are absent from every seller read of an order and from the public lookup', async () => {
		const { order } = await placeOrder();
		await request(app).patch(`/api/admin/orders/${order._id}/notes`).set('Cookie', admin.cookies)
			.send({ note: 'secret-internal-note' });
		expect((await Order.findById(order._id).lean()).internalNotes).toHaveLength(1);

		const detail = await request(app).get(`/api/seller/orders/${order._id}`).set('Cookie', admin.cookies);
		const list = await request(app).get('/api/seller/orders').set('Cookie', admin.cookies);
		const status = await request(app).put(`/api/seller/orders/${order._id}/status`).set('Cookie', admin.cookies)
			.send({ status: 'paid', transactionCode: 'TX1' });
		const publicLookup = await request(app).get(`/api/orders/${order.orderCode}`);

		for (const res of [detail, list, status, publicLookup]) {
			expect(res.status).toBe(200);
			expect(JSON.stringify(res.body)).not.toContain('internalNotes');
			expect(JSON.stringify(res.body)).not.toContain('secret-internal-note');
		}

		const adminDetail = await request(app).get(`/api/admin/orders/${order._id}`).set('Cookie', admin.cookies);
		expect(adminDetail.body.data.internalNotes).toHaveLength(1);
	});
});

describe('the stock ledger', () => {
	it('no longer knows an order_restore movement', async () => {
		const product = await makeProduct();

		await expect(recordMovement({
			productId: product._id,
			type: 'order_restore',
			delta: -1,
			idempotencyKey: `restore:${randomUUID()}`,
			createdBy: 'test'
		})).rejects.toThrow(/unknown movement type/);
		expect(await movementCount(product)).toBe(0);
	});
});
