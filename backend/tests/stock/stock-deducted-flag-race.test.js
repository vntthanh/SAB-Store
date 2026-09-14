/**
 * F8 — the `stockDeducted` flag write after a status transition used to be a
 * separate, UNGUARDED `Order.updateOne({_id}, {$set:{stockDeducted}})`. An
 * interleaved cancel + immediate un-cancel (two requests racing the same
 * order) could have the first request's flag write land *after* a second
 * request had already transitioned the order further and written its own
 * correct flag value — the first request's unconditional write then
 * silently clobbered it.
 *
 * `applyStatusTransitionStockEffect` is mocked to deterministically simulate
 * that race: while request A's stock effect is "in flight", the mock mutates
 * the order directly (as request B, running to completion, would have) and
 * then returns A's own intended flag value. This proves A's follow-up write
 * is now guarded on the (status, stockDeducted) pair A's own decision was
 * based on, instead of blindly overwriting whatever is in the DB by the time
 * it runs.
 */
jest.mock('../../services/stock', () => ({
	...jest.requireActual('../../services/stock'),
	applyStatusTransitionStockEffect: jest.fn()
}));

const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');
const { applyStatusTransitionStockEffect } = require('../../services/stock');
const Order = require('../../models/Order');

async function makeDirectSaleOrder(overrides = {}) {
	const product = await makeProduct({ stockQuantity: 10 });
	const n = Math.floor(Math.random() * 1e9);
	const order = await Order.create({
		orderCode: `D${n}`,
		fullName: 'NB: seller',
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

describe('PUT /api/admin/orders/:id — stockDeducted flag write is guarded (F8)', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	afterEach(() => {
		applyStatusTransitionStockEffect.mockReset();
	});

	it('does not clobber a concurrent request\'s already-written stockDeducted flag', async () => {
		const { order } = await makeDirectSaleOrder(); // status: paid, stockDeducted: true

		applyStatusTransitionStockEffect.mockImplementation(async () => {
			// Simulate a second, concurrent request (B) that raced in between
			// this request's (A's) status transition and its own flag write:
			// B un-cancelled the order and left it in a consistent state
			// (status: paid, stockDeducted: true) before A's flag write runs.
			await Order.updateOne({ _id: order._id }, { $set: { status: 'paid', stockDeducted: true } });
			// A (this cancel) decided stock should end up restored.
			return false;
		});

		const res = await request(app)
			.put(`/api/admin/orders/${order._id}`)
			.set('Cookie', cookies)
			.send({ status: 'cancelled', cancelReason: 'race' });

		expect(res.status).toBe(200);

		const saved = await Order.findById(order._id);
		// B's write must survive: without the guard, A's unconditional
		// `$set: { stockDeducted: false }` would have overwritten it here,
		// producing exactly the corrupted state F8 describes — a "paid" order
		// (per B) whose flag (per A) claims its stock was never deducted.
		expect(saved.stockDeducted).toBe(true);
	});
});
