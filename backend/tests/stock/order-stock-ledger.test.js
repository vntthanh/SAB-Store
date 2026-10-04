/**
 * Orders and the stock ledger: an order records its stock movements in the same
 * transaction that creates it, never checks stock, and the cache only changes
 * once the movements are applied. Every assertion re-reads MongoDB.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeAdminSession } = require('../helpers/factories');
const { applyPendingMovements } = require('../helpers/stock');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const StockMovement = require('../../models/StockMovement');
const stockQueue = require('../../queues/stock-queue');

const stockOf = async (product) => (await Product.findById(product._id).lean()).stockQuantity;
const movementsOf = (product) => StockMovement.find({ productId: product._id }).sort({ createdAt: 1, _id: 1 }).lean();

const customer = {
	studentId: '24120001',
	fullName: 'Nguyen Van A',
	email: 'a@example.com',
	phoneNumber: '0987654321'
};

let app;
let admin;

beforeAll(async () => {
	await Promise.all([Order.init(), StockMovement.init()]);
	app = buildTestApp();
});

beforeEach(async () => {
	admin = await makeAdminSession(app); // admin passes authenticateSeller too
});

afterEach(() => {
	jest.restoreAllMocks();
});

const placeOnline = (items, expectedTotal, extra = {}) =>
	request(app).post('/api/orders').send({ ...customer, items, expectedTotal, ...extra });

const placeDirect = (items, expectedTotal, extra = {}) =>
	request(app).post('/api/seller/orders/direct').set('Cookie', admin.cookies).send({ items, expectedTotal, ...extra });

const line = (product, quantity) => ({ productId: String(product._id), quantity });

describe('POST /api/orders — stock ledger', () => {
	it('accepts an order for a product with no stock and records a pending order movement', async () => {
		const product = await makeProduct({ stockQuantity: 0, price: 10000 });

		const res = await placeOnline([line(product, 3)], 30000);

		expect(res.status).toBe(201);
		const order = await Order.findOne({ orderCode: res.body.data.orderCode }).lean();
		expect(order.stockDeducted).toBe(true);

		const movements = await movementsOf(product);
		expect(movements).toHaveLength(1);
		expect(movements[0]).toMatchObject({
			type: 'order',
			delta: -3,
			status: 'pending',
			idempotencyKey: `order:${order._id}:${product._id}:create`
		});
		expect(String(movements[0].orderId)).toBe(String(order._id));
		// Only the worker writes the cache.
		expect(await stockOf(product)).toBe(0);

		await applyPendingMovements();
		expect(await stockOf(product)).toBe(-3);
	});

	it('records one movement per product with combo and retail lines of it counted together', async () => {
		await makeCombo({ price: 15000, categoryRequirements: [{ category: 'ledger-combo', quantity: 2 }] });
		const product = await makeProduct({ category: 'ledger-combo', price: 10000, stockQuantity: 10 });

		const res = await placeOnline([line(product, 3)], 25000); // one combo (15000) + one retail (10000)

		expect(res.status).toBe(201);
		const movements = await movementsOf(product);
		expect(movements).toHaveLength(1);
		expect(movements[0].delta).toBe(-3);
	});

	it('hands the movements to the queue only after the order has committed', async () => {
		const product = await makeProduct({ price: 10000 });
		let ordersVisibleAtEnqueue = null;
		let enqueued = null;
		jest.spyOn(stockQueue, 'enqueueMovementJobs').mockImplementation(async (ids) => {
			ordersVisibleAtEnqueue = await Order.countDocuments();
			enqueued = ids;
		});

		const res = await placeOnline([line(product, 1)], 10000);

		expect(res.status).toBe(201);
		expect(ordersVisibleAtEnqueue).toBe(1);
		const [movement] = await movementsOf(product);
		expect(enqueued).toEqual([String(movement._id)]);
	});

	it('still creates the order when the queue is unreachable', async () => {
		const product = await makeProduct({ price: 10000 });
		jest.spyOn(stockQueue, 'enqueueMovementJobs').mockRejectedValue(new Error('redis down'));

		const res = await placeOnline([line(product, 1)], 10000);

		expect(res.status).toBe(201);
		expect(await Order.countDocuments()).toBe(1);
		expect(await movementsOf(product)).toHaveLength(1);
	});

	it('leaves no order and no movement when the transaction fails after the order was written', async () => {
		const product = await makeProduct({ price: 10000 });
		jest.spyOn(StockMovement, 'create').mockRejectedValueOnce(new Error('disk full'));

		const res = await placeOnline([line(product, 1)], 10000);

		expect(res.status).toBe(500);
		expect(await Order.countDocuments()).toBe(0);
		expect(await StockMovement.countDocuments()).toBe(0);
	});

	it('creates nothing when the displayed total is stale', async () => {
		const product = await makeProduct({ price: 10000 });

		const res = await placeOnline([line(product, 1)], 9999);

		expect(res.status).toBe(409);
		expect(await Order.countDocuments()).toBe(0);
		expect(await StockMovement.countDocuments()).toBe(0);
	});

	it('rejects a quantity below the product minimum', async () => {
		const product = await makeProduct({ price: 10000, minOrderQuantity: 3 });

		const res = await placeOnline([line(product, 2)], 20000);

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('QUANTITY_OUT_OF_RANGE');
		expect(await Order.countDocuments()).toBe(0);
		expect(await StockMovement.countDocuments()).toBe(0);
	});

	it('rejects a quantity over the maximum even when the client sends allowOverMax', async () => {
		const product = await makeProduct({ price: 10000, maxOrderQuantity: 2 });

		const res = await placeOnline([line(product, 3)], 30000, { allowOverMax: true });

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('QUANTITY_OUT_OF_RANGE');
		expect(await Order.countDocuments()).toBe(0);
	});

	it('accepts two orders for the last unit and lands at -1 once applied', async () => {
		const product = await makeProduct({ stockQuantity: 1, price: 10000 });

		const responses = await Promise.all([
			placeOnline([line(product, 1)], 10000, { studentId: '24120001' }),
			placeOnline([line(product, 1)], 10000, { studentId: '24120002' })
		]);

		expect(responses.map((r) => r.status)).toEqual([201, 201]);
		expect(await movementsOf(product)).toHaveLength(2);

		await applyPendingMovements();
		expect(await stockOf(product)).toBe(-1);
	});
});

describe('POST /api/seller/orders/direct — stock ledger', () => {
	it('accepts a counter sale at zero stock and records a pending order movement', async () => {
		const product = await makeProduct({ stockQuantity: 0, price: 20000 });

		const res = await placeDirect([line(product, 2)], 40000);

		expect(res.status).toBe(201);
		const order = await Order.findById(res.body.data._id).lean();
		expect(order).toMatchObject({ isDirectSale: true, stockDeducted: true });

		const movements = await movementsOf(product);
		expect(movements).toHaveLength(1);
		expect(movements[0]).toMatchObject({ type: 'order', delta: -2, status: 'pending' });
		expect(movements[0].idempotencyKey).toBe(`order:${order._id}:${product._id}:create`);

		await applyPendingMovements();
		expect(await stockOf(product)).toBe(-2);
	});

	it('gives simultaneous counter sales distinct order numbers and accepts them all', async () => {
		const product = await makeProduct({ stockQuantity: 1, price: 20000 });

		const responses = await Promise.all(Array.from({ length: 5 }, () => placeDirect([line(product, 1)], 20000)));

		expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
		const numbers = (await Order.find().lean()).map((o) => o.orderNumber);
		expect(new Set(numbers).size).toBe(5);

		await applyPendingMovements();
		expect(await stockOf(product)).toBe(-4);
	}, 30000);

	it('leaves no order and no movement when the transaction fails after the order was written', async () => {
		const product = await makeProduct({ price: 20000 });
		jest.spyOn(StockMovement, 'create').mockRejectedValueOnce(new Error('disk full'));

		const res = await placeDirect([line(product, 1)], 20000);

		expect(res.status).toBe(500);
		expect(await Order.countDocuments()).toBe(0);
		expect(await StockMovement.countDocuments()).toBe(0);
	});

	it('asks for confirmation over the maximum: 409 listing the lines, nothing created', async () => {
		const product = await makeProduct({ name: 'Limited Mug', price: 20000, maxOrderQuantity: 2 });

		const res = await placeDirect([line(product, 5)], 100000);

		expect(res.status).toBe(409);
		expect(res.body.code).toBe('QUANTITY_OVER_MAX');
		expect(res.body.details.lines).toEqual([
			{ productId: String(product._id), productName: 'Limited Mug', quantity: 5, max: 2 }
		]);
		expect(await Order.countDocuments()).toBe(0);
		expect(await StockMovement.countDocuments()).toBe(0);
	});

	it('sells over the maximum once confirmed and notes who confirmed it', async () => {
		const product = await makeProduct({ price: 20000, maxOrderQuantity: 2 });

		const res = await placeDirect([line(product, 5)], 100000, { allowOverMax: true });

		expect(res.status).toBe(201);
		const order = await Order.findById(res.body.data._id).lean();
		expect(order.statusHistory[0].note).toBe(`Bán vượt số lượng tối đa — xác nhận bởi ${admin.username}`);
		expect((await movementsOf(product))[0].delta).toBe(-5);
	});

	it('adds no note when the confirmation flag was sent but nothing exceeded a maximum', async () => {
		const product = await makeProduct({ price: 20000, maxOrderQuantity: 10 });

		const res = await placeDirect([line(product, 1)], 20000, { allowOverMax: true });

		expect(res.status).toBe(201);
		const order = await Order.findById(res.body.data._id).lean();
		expect(order.statusHistory[0].note).toBeUndefined();
	});

	it('refuses 201 units even with the confirmation flag', async () => {
		const product = await makeProduct({ price: 1, maxOrderQuantity: 2 });

		const res = await placeDirect([line(product, 201)], 201, { allowOverMax: true });

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('CART_TOO_MANY_UNITS');
		expect(await Order.countDocuments()).toBe(0);
	});

	it('keeps the minimum a hard limit even with the confirmation flag', async () => {
		const product = await makeProduct({ price: 20000, minOrderQuantity: 3 });

		const res = await placeDirect([line(product, 1)], 20000, { allowOverMax: true });

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('QUANTITY_OUT_OF_RANGE');
	});
});

/** An order created through the route, so it carries the ledger state a real one has. */
async function placeOrderWithStock(quantity = 2, price = 10000) {
	const product = await makeProduct({ stockQuantity: 10, price });
	const res = await placeOnline([line(product, quantity)], price * quantity);
	expect(res.status).toBe(201);
	const order = await Order.findOne({ orderCode: res.body.data.orderCode });
	await applyPendingMovements();
	return { order, product };
}

/** An order from before stock was tracked per order: it never took stock. */
async function insertLegacyOrder(status = 'confirmed') {
	const product = await makeProduct({ stockQuantity: 10 });
	const n = Math.floor(Math.random() * 1e8);
	const { insertedId } = await Order.collection.insertOne({
		orderCode: `L${n}`,
		studentId: `SV${n}`,
		fullName: 'Legacy Buyer',
		email: `legacy${n}@test.vn`,
		phoneNumber: '0912345678',
		items: [{ productId: product._id, productName: product.name, price: product.price, quantity: 2 }],
		totalAmount: product.price * 2,
		status,
		isDirectSale: false,
		stockDeducted: false,
		statusHistory: [{ status, updatedBy: 'system', updatedAt: new Date() }],
		createdAt: new Date(),
		updatedAt: new Date()
	});
	return { orderId: insertedId, product };
}

describe.each([
	['admin', (id) => `/api/admin/orders/${id}`],
	['seller', (id) => `/api/seller/orders/${id}/status`]
])('%s status change — stock ledger', (_who, urlFor) => {
	const change = (id, body) => request(app).put(urlFor(id)).set('Cookie', admin.cookies).send(body);

	it('records an order_cancel movement and clears stockDeducted when cancelling', async () => {
		const { order, product } = await placeOrderWithStock(2);

		const res = await change(order._id, { status: 'cancelled', cancelReason: 'test' });

		expect(res.status).toBe(200);
		const saved = await Order.findById(order._id).lean();
		expect(saved).toMatchObject({ status: 'cancelled', stockDeducted: false });

		const cancel = (await movementsOf(product)).find((m) => m.type === 'order_cancel');
		expect(cancel).toMatchObject({ delta: 2, status: 'pending', createdBy: admin.username });
		expect(String(cancel.orderId)).toBe(String(order._id));

		await applyPendingMovements();
		expect(await stockOf(product)).toBe(10);
	});

	it('records nothing when cancelling an order that never took stock', async () => {
		const { orderId, product } = await insertLegacyOrder();

		const res = await change(orderId, { status: 'cancelled', cancelReason: 'legacy' });

		expect(res.status).toBe(200);
		expect(await Order.findById(orderId).lean()).toMatchObject({ status: 'cancelled', stockDeducted: false });
		expect(await movementsOf(product)).toHaveLength(0);
	});

	it('records nothing for a change that is not a cancel', async () => {
		const { order, product } = await placeOrderWithStock(2);
		const before = (await movementsOf(product)).length;

		const res = await change(order._id, { status: 'paid', transactionCode: 'TX1' });

		expect(res.status).toBe(200);
		expect(await movementsOf(product)).toHaveLength(before);
		expect(await Order.findById(order._id).lean()).toMatchObject({ status: 'paid', stockDeducted: true });
	});

	it('leaves status, flag and movements untouched when the transaction fails', async () => {
		const { order, product } = await placeOrderWithStock(2);
		const before = (await movementsOf(product)).length;
		jest.spyOn(StockMovement, 'create').mockRejectedValueOnce(new Error('disk full'));

		const res = await change(order._id, { status: 'cancelled' });

		expect(res.status).toBe(500);
		expect(await Order.findById(order._id).lean()).toMatchObject({ status: 'confirmed', stockDeducted: true });
		expect(await movementsOf(product)).toHaveLength(before);
	});

	it('answers one of two simultaneous cancels with 409 and returns the stock once', async () => {
		const { order, product } = await placeOrderWithStock(2);

		const responses = await Promise.all([
			change(order._id, { status: 'cancelled', cancelReason: 'a' }),
			change(order._id, { status: 'cancelled', cancelReason: 'b' })
		]);

		expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
		const cancels = (await movementsOf(product)).filter((m) => m.type === 'order_cancel');
		expect(cancels).toHaveLength(1);
		await applyPendingMovements();
		expect(await stockOf(product)).toBe(10);
	});

	it('still cancels an order whose product was deleted', async () => {
		const { order, product } = await placeOrderWithStock(2);
		await Product.deleteOne({ _id: product._id });

		const res = await change(order._id, { status: 'cancelled' });

		expect(res.status).toBe(200);
		await applyPendingMovements();
		expect(await Order.findById(order._id).lean()).toMatchObject({ status: 'cancelled', stockDeducted: false });
		const cancel = (await movementsOf(product)).find((m) => m.type === 'order_cancel');
		expect(cancel).toMatchObject({ status: 'applied', lastError: 'PRODUCT_NOT_FOUND' });
	});

	it('lets exactly one of a cancel and a delivery win and keeps stock consistent with the winner', async () => {
		const { order, product } = await placeOrderWithStock(2);

		const [cancel, deliver] = await Promise.all([
			change(order._id, { status: 'cancelled', cancelReason: 'race' }),
			change(order._id, { status: 'delivered' })
		]);
		await applyPendingMovements();

		expect([cancel.status, deliver.status].sort()).toEqual([200, 409]);
		const saved = await Order.findById(order._id).lean();
		const cancelWon = cancel.status === 200;
		expect(saved.status).toBe(cancelWon ? 'cancelled' : 'delivered');
		expect(saved.stockDeducted).toBe(!cancelWon);
		expect(await stockOf(product)).toBe(cancelWon ? 10 : 8);
	});

	it('hands the movements to the queue after the commit', async () => {
		const { order, product } = await placeOrderWithStock(2);
		let statusAtEnqueue = null;
		jest.spyOn(stockQueue, 'enqueueMovementJobs').mockImplementation(async () => {
			statusAtEnqueue = (await Order.findById(order._id).lean()).status;
		});

		const res = await change(order._id, { status: 'cancelled' });

		expect(res.status).toBe(200);
		expect(statusAtEnqueue).toBe('cancelled');
		expect(stockQueue.enqueueMovementJobs).toHaveBeenCalledTimes(1);
		const cancel = (await movementsOf(product)).find((m) => m.type === 'order_cancel');
		expect(stockQueue.enqueueMovementJobs).toHaveBeenCalledWith([String(cancel._id)]);
	});
});
