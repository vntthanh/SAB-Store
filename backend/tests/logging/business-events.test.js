/**
 * Business events are asserted against real requests and real MongoDB state;
 * console.log is only spied on to capture the lines.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeAdminSession } = require('../helpers/factories');
const { expectedTotalFor } = require('../helpers/pricing');
const Order = require('../../models/Order');
const StockMovement = require('../../models/StockMovement');
const stockQueue = require('../../queues/stock-queue');
const { recordMovement, applyMovement } = require('../../services/stock-ledger');
const mongoose = require('mongoose');

const customer = {
	studentId: '24120001',
	fullName: 'Nguyen Van A',
	email: 'a@example.com',
	phoneNumber: '0987654321'
};
const PERSONAL = ['studentId', 'fullName', 'email', 'phoneNumber', 'phone', 'orderCode', 'transactionCode', 'additionalNote'];

let app;
let admin;
let logSpy;

beforeAll(async () => {
	await Promise.all([Order.init(), StockMovement.init()]);
	app = buildTestApp();
});

beforeEach(async () => {
	admin = await makeAdminSession(app);
	logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
	jest.restoreAllMocks();
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
const events = (name) => logSpy.mock.calls
	.map(([line]) => { try { return JSON.parse(line); } catch { return null; } })
	.filter((entry) => entry && entry.type === 'event' && (!name || entry.event === name));

const expectNoPersonalData = (line) => {
	for (const field of PERSONAL) expect(line).not.toHaveProperty(field);
	expect(JSON.stringify(line)).not.toMatch(/24120001|Nguyen|a@example|0987654321/);
};

describe('order.created', () => {
	it('is logged once for an online order, after it is stored, without personal data', async () => {
		const product = await makeProduct({ price: 100000, stockQuantity: 5 });
		const items = [{ productId: String(product._id), quantity: 2 }];

		const res = await request(app)
			.post('/api/orders')
			.send({ ...customer, items, expectedTotal: await expectedTotalFor(items) });
		expect(res.status).toBe(201);
		await settle();

		expect(await Order.countDocuments({ orderCode: res.body.data.orderCode })).toBe(1);
		const created = events('order.created');
		expect(created).toHaveLength(1);
		expect(created[0]).toEqual({
			type: 'event',
			event: 'order.created',
			channel: 'online',
			items: 2,
			totalAmount: 200000,
			comboApplied: false
		});
		expectNoPersonalData(created[0]);
		expect(JSON.stringify(created[0])).not.toContain(res.body.data.orderCode);
	});

	it('is logged once for a counter sale, with the combo flag', async () => {
		await makeCombo({
			name: 'Log Combo',
			price: 15000,
			categoryRequirements: [{ category: 'log-events-test', quantity: 2 }]
		});
		const product = await makeProduct({ category: 'log-events-test', price: 10000, stockQuantity: 10 });
		const items = [{ productId: String(product._id), quantity: 2 }];

		const res = await request(app)
			.post('/api/seller/orders/direct')
			.set('Cookie', admin.cookies)
			.send({ items, expectedTotal: 15000 });
		expect(res.status).toBe(201);
		await settle();

		const created = events('order.created');
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ channel: 'offline', items: 2, totalAmount: 15000, comboApplied: true });
		expectNoPersonalData(created[0]);
	});

	it('is not logged when the transaction fails after the order was written', async () => {
		const product = await makeProduct({ price: 100000, stockQuantity: 5 });
		const items = [{ productId: String(product._id), quantity: 1 }];
		jest.spyOn(console, 'error').mockImplementation(() => {});
		jest.spyOn(StockMovement, 'create').mockRejectedValueOnce(new Error('movement write failed'));

		const res = await request(app)
			.post('/api/orders')
			.send({ ...customer, items, expectedTotal: await expectedTotalFor(items) });
		expect(res.status).toBe(500);
		await settle();

		expect(await Order.countDocuments({ studentId: customer.studentId })).toBe(0);
		expect(await StockMovement.countDocuments({})).toBe(0);
		expect(events('order.created')).toHaveLength(0);
	});
});

describe('order.status', () => {
	async function webOrder() {
		const product = await makeProduct({ stockQuantity: 10 });
		const n = Math.floor(Math.random() * 1e8);
		return Order.create({
			orderCode: `W${n}`,
			studentId: customer.studentId,
			fullName: customer.fullName,
			email: customer.email,
			phoneNumber: customer.phoneNumber,
			items: [{ productId: product._id, productName: product.name, price: product.price, quantity: 1 }],
			totalAmount: product.price,
			status: 'confirmed',
			stockDeducted: true,
			statusHistory: [{ status: 'confirmed', updatedBy: 'system', updatedAt: new Date() }]
		});
	}

	it('is logged once per successful transition with from and to only', async () => {
		const order = await webOrder();
		const res = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', admin.cookies)
			.send({ status: 'paid', transactionCode: 'TX-SECRET-1' });
		expect(res.status).toBe(200);

		const lines = events('order.status');
		expect(lines).toEqual([{ type: 'event', event: 'order.status', from: 'confirmed', to: 'paid' }]);
		expect(JSON.stringify(lines)).not.toContain('TX-SECRET-1');
	});

	it('is not logged when the order is missing', async () => {
		const res = await request(app)
			.put('/api/admin/orders/64b000000000000000000000')
			.set('Cookie', admin.cookies)
			.send({ status: 'paid' });
		expect(res.status).toBe(404);
		expect(events('order.status')).toHaveLength(0);
	});
});

describe('order.status from the seller route', () => {
	it('is logged once per successful transition with from and to only', async () => {
		const product = await makeProduct({ stockQuantity: 10 });
		const order = await Order.create({
			orderCode: `S${Math.floor(Math.random() * 1e8)}`,
			studentId: customer.studentId,
			fullName: customer.fullName,
			email: customer.email,
			phoneNumber: customer.phoneNumber,
			items: [{ productId: product._id, productName: product.name, price: product.price, quantity: 1 }],
			totalAmount: product.price,
			status: 'confirmed',
			stockDeducted: true,
			statusHistory: [{ status: 'confirmed', updatedBy: 'system', updatedAt: new Date() }]
		});

		const res = await request(app)
			.put(`/api/seller/orders/${order._id}/status`)
			.set('Cookie', admin.cookies)
			.send({ status: 'paid', transactionCode: 'TX-SECRET-2' });
		expect(res.status).toBe(200);

		const lines = events('order.status');
		expect(lines).toEqual([{ type: 'event', event: 'order.status', from: 'confirmed', to: 'paid' }]);
		expect(JSON.stringify(lines)).not.toContain('TX-SECRET-2');
	});
});

describe('stock movement events', () => {
	const adjust = async (productId, delta) => recordMovement({
		productId, type: 'adjust', delta, idempotencyKey: `log-events-${productId}-${delta}`
	});

	it('logs stock.movement.applied with type and duration', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const movement = await adjust(product._id, 3);

		await applyMovement(movement._id);

		const applied = events('stock.movement.applied');
		expect(applied).toHaveLength(1);
		expect(applied[0]).toMatchObject({ type: 'event', movementType: 'adjust' });
		expect(Number.isInteger(applied[0].ms)).toBe(true);
		expect((await StockMovement.findById(movement._id)).status).toBe('applied');
	});

	it('does not log applied again for a movement that is already applied', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const movement = await adjust(product._id, 3);
		await applyMovement(movement._id);
		await applyMovement(movement._id);
		expect(events('stock.movement.applied')).toHaveLength(1);
	});

	it('logs stock.movement.failed with attempts and a truncated error', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const movement = await adjust(product._id, 3);
		jest.spyOn(console, 'error').mockImplementation(() => {});
		jest.spyOn(mongoose, 'startSession').mockRejectedValueOnce(new Error('x'.repeat(500)));

		await expect(applyMovement(movement._id)).rejects.toThrow();

		const failed = events('stock.movement.failed');
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({ type: 'event', movementType: 'adjust', attempts: 1 });
		expect(failed[0].error).toHaveLength(200);
		expect(events('stock.movement.applied')).toHaveLength(0);
		expect((await StockMovement.findById(movement._id)).status).toBe('pending');
	});
});

describe('stock.sweeper', () => {
	it('reports pending count and the age of the oldest in seconds', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const movement = await recordMovement({
			productId: product._id, type: 'adjust', delta: 1, idempotencyKey: `sweeper-${product._id}`
		});
		await StockMovement.collection.updateOne({ _id: movement._id }, { $set: { createdAt: new Date(Date.now() - 90_000) } });

		const backlog = await stockQueue.pendingBacklog();
		expect(backlog.pending).toBeGreaterThanOrEqual(1);
		expect(backlog.oldestPendingSec).toBeGreaterThanOrEqual(90);
	});

	it('emits one stock.sweeper line per pass, even with nothing to re-enqueue', async () => {
		await stockQueue.sweepAndReport({ olderThanMs: 60_000 });

		const lines = events('stock.sweeper');
		expect(lines).toHaveLength(1);
		expect(Object.keys(lines[0]).sort()).toEqual(['event', 'oldestPendingSec', 'pending', 'type']);
		expect(Number.isInteger(lines[0].pending)).toBe(true);
	});

	it('still reports the backlog when the re-enqueue step fails, and surfaces that failure', async () => {
		jest.spyOn(StockMovement, 'find').mockImplementationOnce(() => { throw new Error('redis down'); });

		await expect(stockQueue.sweepAndReport({ olderThanMs: 60_000 })).rejects.toThrow('redis down');

		expect(events('stock.sweeper')).toHaveLength(1);
	});
});
