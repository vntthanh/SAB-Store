/**
 * PUT /api/admin/orders/:id/items — an admin swaps the products of an existing
 * order, and the order's stored total never changes. Every assertion re-reads
 * the database instead of trusting the response or a mock.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeAdminSession, makeSellerSession } = require('../helpers/factories');
const { applyPendingMovements } = require('../helpers/stock');
const { expectedTotalFor } = require('../helpers/pricing');
const { reconcile } = require('../../services/stock-ledger');
const {
	findOrder, findOrderByCode, movements, countRows, patchProduct, patchOrder, unsetOrderField, failNextMovementInsert,
	stockOf: cachedStock,
	stockKeyIdOf,
} = require('../helpers/db');
const { POSTGRES } = require('../helpers/backend');

const customer = {
	studentId: '24120001',
	fullName: 'Nguyen Van A',
	email: 'a@example.com',
	phoneNumber: '0987654321'
};

const PRICE = 100000;

let app;
let admin;

beforeAll(() => {
	app = buildTestApp();
});

beforeEach(async () => {
	admin = await makeAdminSession(app);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// Products start at 0 stock so the cache equals the (empty) ledger sum and
// reconcile() can be asserted empty after any sequence of orders and edits.
const product = (overrides = {}) => makeProduct({ price: PRICE, stockQuantity: 0, ...overrides });
const line = (p, quantity = 1) => ({ productId: String(p._id), quantity });

async function placeOrder(lines) {
	const items = lines.map(({ productId, quantity }) => ({ productId, quantity }));
	const res = await request(app)
		.post('/api/orders')
		.send({ ...customer, items, expectedTotal: await expectedTotalFor(items) });
	expect(res.status).toBe(201);
	const order = await findOrderByCode(res.body.data.orderCode);
	await applyPendingMovements();
	return order;
}

const edit = (id, body, cookies = admin.cookies) =>
	request(app).put(`/api/admin/orders/${id}/items`).set('Cookie', cookies).send({
		expectedRevision: 0,
		reason: 'Khách đổi màu',
		...body
	});

const reload = (order) => findOrder(order._id);
const stockOf = (p) => cachedStock(p._id);
const editMovements = (filter = {}) => movements({ type: 'order_edit', ...filter });

async function makeSellerCookies() {
	return (await makeSellerSession(app)).cookies;
}

describe('PUT /api/admin/orders/:id/items', () => {
	it('swaps a product at the same price, records history and the stock difference', async () => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a)]);

		const res = await edit(order._id, { items: [line(b)] });

		expect(res.status).toBe(200);
		const stored = await reload(order);
		expect(stored.items.map((i) => String(i.productId))).toEqual([String(b._id)]);
		expect(stored.totalAmount).toBe(order.totalAmount);
		expect(stored.itemsRevision).toBe(1);
		expect(stored.itemsHistory).toHaveLength(1);
		expect(stored.itemsHistory[0]).toMatchObject({ editedBy: admin.username, reason: 'Khách đổi màu' });
		expect(stored.itemsHistory[0].previousItems.map((i) => String(i.productId))).toEqual([String(a._id)]);

		const movements = await editMovements();
		expect(movements.map((m) => [String(m.productId), m.delta, m.status, m.idempotencyKey]).sort()).toEqual([
			[String(a._id), 1, 'pending', `order:${order._id}:${await stockKeyIdOf(a._id)}:edit:1`],
			[String(b._id), -1, 'pending', `order:${order._id}:${await stockKeyIdOf(b._id)}:edit:1`]
		].sort());
		expect(movements.every((m) => m.reason === `Sửa đơn ${order.orderCode}`)).toBe(true);

		await applyPendingMovements();
		expect(await stockOf(a)).toBe(0);
		expect(await stockOf(b)).toBe(-1);
		expect(await reconcile()).toEqual([]);
	});

	it('refuses a set that costs more and writes nothing', async () => {
		const a = await product();
		const pricey = await product({ price: 150000 });
		const order = await placeOrder([line(a)]);
		const before = await reload(order);
		const movementsBefore = await countRows('movement');

		const res = await edit(order._id, { items: [line(pricey)] });

		expect(res.status).toBe(409);
		expect(res.body).toMatchObject({
			code: 'ORDER_TOTAL_CHANGED',
			details: { expected: PRICE, actual: 150000 }
		});
		expect(await reload(order)).toEqual(before);
		expect(await countRows('movement')).toBe(movementsBefore);
	});

	it('stores a comboInfo that matches the new items when a combo makes the total equal', async () => {
		await makeCombo();
		const [a, b, c] = [await product(), await product(), await product()];
		const order = await placeOrder([line(a, 3)]);
		expect(order.totalAmount).toBe(250000);

		const res = await edit(order._id, { items: [line(a), line(b), line(c)] });

		expect(res.status).toBe(200);
		const stored = await reload(order);
		expect(stored.totalAmount).toBe(250000);
		const retail = stored.items.filter((i) => !i.fromCombo).reduce((sum, i) => sum + i.price * i.quantity, 0);
		expect(stored.comboInfo.finalTotal + retail).toBe(stored.totalAmount);
		const unitsOf = (id) => stored.items.filter((i) => String(i.productId) === String(id)).reduce((s, i) => s + i.quantity, 0);
		expect([unitsOf(a._id), unitsOf(b._id), unitsOf(c._id)]).toEqual([1, 1, 1]);
		expect(stored.items.filter((i) => i.fromCombo).every((i) => i.comboId)).toBe(true);

		await applyPendingMovements();
		expect(await reconcile()).toEqual([]);
	});

	it.each(['cancelled', 'delivered'])('refuses a %s order with ORDER_FINAL', async (status) => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a)]);
		const change = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', admin.cookies)
			.send(status === 'cancelled' ? { status, cancelReason: 'x' } : { status });
		expect(change.status).toBe(200);
		await applyPendingMovements();
		const before = await reload(order);

		const res = await edit(order._id, { items: [line(b)] });

		expect(res.status).toBe(409);
		expect(res.body.code).toBe('ORDER_FINAL');
		expect(await reload(order)).toEqual(before);
		expect(await editMovements()).toHaveLength(0);
	});

	it('refuses a stale expectedRevision with ORDER_CHANGED', async () => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a)]);
		const before = await reload(order);

		const res = await edit(order._id, { items: [line(b)], expectedRevision: 3 });

		expect(res.status).toBe(409);
		expect(res.body.code).toBe('ORDER_CHANGED');
		expect(await reload(order)).toEqual(before);
		expect(await editMovements()).toHaveLength(0);
	});

	it('lets exactly one of two concurrent saves at the same revision win', async () => {
		const [a, b, c] = [await product(), await product(), await product()];
		const order = await placeOrder([line(a)]);

		const [first, second] = await Promise.all([
			edit(order._id, { items: [line(b)] }),
			edit(order._id, { items: [line(c)] })
		]);

		expect([first.status, second.status].sort()).toEqual([200, 409]);
		const loser = first.status === 409 ? first : second;
		expect(loser.body.code).toBe('ORDER_CHANGED');
		const stored = await reload(order);
		expect(stored.itemsRevision).toBe(1);
		expect(stored.itemsHistory).toHaveLength(1);
		const winnerProduct = String(stored.items[0].productId);
		expect([String(b._id), String(c._id)]).toContain(winnerProduct);
		const movements = await editMovements();
		expect(movements.map((m) => String(m.productId)).sort()).toEqual([String(a._id), winnerProduct].sort());

		await applyPendingMovements();
		expect(await reconcile()).toEqual([]);
	});

	it('records no movement for an order that never held stock', async () => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a)]);
		await patchOrder(order._id, { stockDeducted: false });
		const movementsBefore = await countRows('movement');

		const res = await edit(order._id, { items: [line(b)] });

		expect(res.status).toBe(200);
		expect((await reload(order)).items[0].productId).toBe(String(b._id));
		expect(await countRows('movement')).toBe(movementsBefore);
	});

	it('answers unchanged and writes nothing when only the line order differs', async () => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a), line(b)]);
		const before = await reload(order);
		const movementsBefore = await countRows('movement');

		const res = await edit(order._id, { items: [line(b), line(a)] });

		expect(res.status).toBe(200);
		expect(res.body.unchanged).toBe(true);
		const after = await reload(order);
		expect(after).toEqual(before);
		expect(after.itemsRevision).toBe(0);
		expect(after.itemsHistory).toHaveLength(0);
		expect(await countRows('movement')).toBe(movementsBefore);
	});

	it('forwards the engine error for a product of the wrong channel or one not on sale', async () => {
		const a = await product();
		const counterOnly = await product({ salesChannel: 'offline' });
		const hidden = await product({ available: false });
		const order = await placeOrder([line(a)]);
		const before = await reload(order);

		const wrongChannel = await edit(order._id, { items: [line(counterOnly)] });
		const unavailable = await edit(order._id, { items: [line(hidden)] });

		expect(wrongChannel.status).toBe(400);
		expect(wrongChannel.body.code).toBe('PRODUCT_CHANNEL_MISMATCH');
		expect(unavailable.status).toBe(400);
		expect(unavailable.body.code).toBe('PRODUCT_UNAVAILABLE');
		expect(await reload(order)).toEqual(before);
	});

	it('rolls the order edit back when recording a movement fails', async () => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a)]);
		const before = await reload(order);
		const movementsBefore = await countRows('movement');
		const fault = failNextMovementInsert('ledger down');
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await edit(order._id, { items: [line(b)] });

		expect(res.status).toBe(500);
		expect(fault.fired()).toBe(true);
		expect(await reload(order)).toEqual(before);
		expect(await countRows('movement')).toBe(movementsBefore);
	});

	it('refuses a seller with 403 and an anonymous caller with 401', async () => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a)]);
		const sellerCookies = await makeSellerCookies();
		const body = { items: [line(b)], expectedRevision: 0, reason: 'x' };

		const asSeller = await request(app).put(`/api/admin/orders/${order._id}/items`).set('Cookie', sellerCookies).send(body);
		const anonymous = await request(app).put(`/api/admin/orders/${order._id}/items`).send(body);

		expect(asSeller.status).toBe(403);
		expect(anonymous.status).toBe(401);
		expect((await reload(order)).itemsRevision).toBe(0);
	});

	it('ignores totalAmount, status and price sent in the body', async () => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a)]);

		const res = await edit(order._id, {
			items: [{ ...line(b), price: 1 }],
			totalAmount: 1,
			status: 'cancelled'
		});

		expect(res.status).toBe(200);
		const stored = await reload(order);
		expect(stored.totalAmount).toBe(PRICE);
		expect(stored.status).toBe('confirmed');
		expect(stored.items[0].price).toBe(PRICE);
	});

	it('rejects more than 200 units with CART_TOO_MANY_UNITS', async () => {
		const a = await product();
		const order = await placeOrder([line(a)]);
		const before = await reload(order);

		const res = await edit(order._id, { items: [line(a, 201)] });

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('CART_TOO_MANY_UNITS');
		expect(await reload(order)).toEqual(before);
	});

	// Skipped on Postgres: unsets a stored field; a Postgres column cannot be missing (itemsRevision is NOT NULL DEFAULT 0).
	it.skipIf(POSTGRES)('edits an order stored without itemsRevision and keeps counting from there', async () => {
		const [a, b, c] = [await product(), await product(), await product()];
		const order = await placeOrder([line(a)]);
		await unsetOrderField(order._id, 'itemsRevision');
		expect((await reload(order)).itemsRevision).toBeUndefined();

		const first = await edit(order._id, { items: [line(b)], expectedRevision: 0 });
		const second = await edit(order._id, { items: [line(c)], expectedRevision: 1 });

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		const stored = await reload(order);
		expect(stored.itemsRevision).toBe(2);
		expect(stored.itemsHistory).toHaveLength(2);
	});

	it('records no movement for a product whose units stay the same while its combo/retail split changes', async () => {
		await makeCombo();
		const [a, b, c] = [await product(), await product(), await product()];
		const order = await placeOrder([line(a, 2), line(b)]);

		const res = await edit(order._id, { items: [line(a, 2), line(c)] });

		expect(res.status).toBe(200);
		const moved = (await editMovements()).map((m) => [String(m.productId), m.delta]).sort();
		expect(moved).toEqual([[String(b._id), 1], [String(c._id), -1]].sort());
		await applyPendingMovements();
		expect(await reconcile()).toEqual([]);
	});

	it('leaves stock consistent when an edit races a cancel', async () => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a)]);

		await Promise.all([
			edit(order._id, { items: [line(b)] }),
			request(app)
				.put(`/api/admin/orders/${order._id}`)
				.set('Cookie', admin.cookies)
				.send({ status: 'cancelled', cancelReason: 'race' })
		]);
		await applyPendingMovements();

		expect((await reload(order)).status).toBe('cancelled');
		expect(await stockOf(a)).toBe(0);
		expect(await stockOf(b)).toBe(0);
		expect(await reconcile()).toEqual([]);
	});

	it('cancelling an edited order gives back the new set', async () => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a)]);
		expect((await edit(order._id, { items: [line(b)] })).status).toBe(200);
		await applyPendingMovements();

		const cancel = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', admin.cookies)
			.send({ status: 'cancelled', cancelReason: 'x' });
		expect(cancel.status).toBe(200);

		const refunds = await movements({ type: 'order_cancel' });
		expect(refunds.map((m) => [String(m.productId), m.delta])).toEqual([[String(b._id), 1]]);
		await applyPendingMovements();
		expect(await stockOf(a)).toBe(0);
		expect(await stockOf(b)).toBe(0);
		expect(await reconcile()).toEqual([]);
	});

	it('succeeds when the product removed from the order has since been withdrawn', async () => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a), line(b)]);
		await patchProduct(b._id, { available: false });

		const res = await edit(order._id, { items: [line(a, 2)] });

		expect(res.status).toBe(200);
		const stored = await reload(order);
		expect(stored.items).toHaveLength(1);
		expect(stored.items[0].quantity).toBe(2);
	});

	it('accepts a reason of exactly 200 characters', async () => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a)]);
		const reason = 'x'.repeat(200);

		const res = await edit(order._id, { items: [line(b)], reason });

		expect(res.status).toBe(200);
		expect((await reload(order)).itemsHistory[0].reason).toBe(reason);
		expect((await editMovements()).every((m) => m.reason === `Sửa đơn ${order.orderCode}`)).toBe(true);
	});

	it('rejects a malformed body before touching the order', async () => {
		const a = await product();
		const order = await placeOrder([line(a)]);
		const bad = [
			{ items: [], expectedRevision: 0, reason: 'x' },
			{ items: [{ productId: 'nope', quantity: 1 }], expectedRevision: 0, reason: 'x' },
			{ items: [{ productId: String(a._id), quantity: 0 }], expectedRevision: 0, reason: 'x' },
			{ items: [line(a)], expectedRevision: -1, reason: 'x' },
			{ items: [line(a)], expectedRevision: 0, reason: '   ' },
			{ items: [line(a)], expectedRevision: 0, reason: 'x'.repeat(201) }
		];

		for (const body of bad) {
			const res = await request(app).put(`/api/admin/orders/${order._id}/items`).set('Cookie', admin.cookies).send(body);
			expect(res.status).toBe(400);
		}
		expect((await reload(order)).itemsRevision).toBe(0);
	});

	it('answers 404 for an unknown order', async () => {
		const a = await product();

		const res = await edit('64b7f0f0f0f0f0f0f0f0f0f0', { items: [line(a)] });

		expect(res.status).toBe(404);
	});
});

describe('itemsHistory visibility', () => {
	it('is left out of the admin list and the seller reads, and kept in the admin detail', async () => {
		const [a, b] = [await product(), await product()];
		const order = await placeOrder([line(a)]);
		expect((await edit(order._id, { items: [line(b)] })).status).toBe(200);

		const list = await request(app).get('/api/admin/orders').set('Cookie', admin.cookies);
		const detail = await request(app).get(`/api/admin/orders/${order._id}`).set('Cookie', admin.cookies);
		const sellerList = await request(app).get('/api/seller/orders').set('Cookie', admin.cookies);
		const sellerDetail = await request(app).get(`/api/seller/orders/${order._id}`).set('Cookie', admin.cookies);
		const sellerStatus = await request(app)
			.put(`/api/seller/orders/${order._id}/status`)
			.set('Cookie', admin.cookies)
			.send({ status: 'paid' });

		expect(list.status).toBe(200);
		expect(list.body.data).toHaveLength(1);
		expect(list.body.data[0]).not.toHaveProperty('itemsHistory');
		expect(detail.body.data.itemsHistory).toHaveLength(1);
		expect(sellerList.status).toBe(200);
		expect(sellerList.body.data[0]).not.toHaveProperty('itemsHistory');
		expect(sellerDetail.status).toBe(200);
		expect(sellerDetail.body.data.order).not.toHaveProperty('itemsHistory');
		expect(sellerStatus.status).toBe(200);
		expect(sellerStatus.body.data.order).not.toHaveProperty('itemsHistory');
	});
});
