/**
 * Integration tests for the order-creation and order-tracking HTTP routes —
 * proving the server never trusts a client-supplied price/total, and that
 * the public tracking endpoint no longer leaks PII (P1-7).
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct } = require('../helpers/factories');
const Order = require('../../models/Order');

function validOrderBody(overrides = {}) {
	// expectedTotal is mandatory; tests that care about it set their own.
	return {
		studentId: '24120001',
		fullName: 'Nguyen Van A',
		email: 'nguyenvana@example.com',
		phoneNumber: '0987654321',
		additionalNote: '',
		items: [],
		expectedTotal: 0,
		...overrides
	};
}

describe('POST /api/orders', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('stores the DB-computed total; a client-computed total of 0 is refused, not stored', async () => {
		const product = await makeProduct({ price: 150000 });
		const items = [{ productId: product._id.toString(), quantity: 2 }];

		const refused = await request(app).post('/api/orders').send(validOrderBody({ items, expectedTotal: 0 }));
		expect(refused.status).toBe(409);
		expect(refused.body.code).toBe('PRICE_CHANGED');
		expect(refused.body.details).toEqual({ expectedTotal: 0, totalAmount: 300000 });
		expect(await Order.countDocuments({})).toBe(0);

		const res = await request(app).post('/api/orders').send(validOrderBody({ items, expectedTotal: 300000 }));

		expect(res.status).toBe(201);
		expect(res.body.success).toBe(true);
		expect(res.body.data.totalAmount).toBe(300000);

		const tracked = await request(app).get(`/api/orders/${res.body.data.orderCode}`);
		expect(tracked.body.data.totalAmount).toBe(300000);
	});

	it('rejects an empty cart rather than creating a free order', async () => {
		const res = await request(app)
			.post('/api/orders')
			.send(validOrderBody({ items: [] }));

		// express-validator's items.isArray({min:1}) rejects this before
		// pricing even runs (see middleware/validation.js's handleValidationErrors,
		// which responds with {message, errors} rather than {success: false}).
		// computeOrderPricing's own EMPTY_CART behavior is covered directly in
		// compute-order-pricing.test.js.
		expect(res.status).toBe(400);
		expect(Array.isArray(res.body.errors)).toBe(true);
	});

	it('rejects an order referencing an unavailable product', async () => {
		const product = await makeProduct({ available: false });

		const res = await request(app)
			.post('/api/orders')
			.send(validOrderBody({ items: [{ productId: product._id.toString(), quantity: 1 }] }));

		expect(res.status).toBe(400);
		expect(res.body.success).toBe(false);
	});

	it('merges duplicate productId lines from the client into one order item', async () => {
		const product = await makeProduct({ price: 20000 });

		const res = await request(app)
			.post('/api/orders')
			.send(
				validOrderBody({
					items: [
						{ productId: product._id.toString(), quantity: 1 },
						{ productId: product._id.toString(), quantity: 2 }
					],
					expectedTotal: 60000
				})
			);

		expect(res.status).toBe(201);
		expect(res.body.data.totalAmount).toBe(60000);
	});
});

describe('GET /api/orders/:orderCode', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('does not return studentId or fullName (P1-7)', async () => {
		const product = await makeProduct({ price: 10000 });

		const createRes = await request(app)
			.post('/api/orders')
			.send(
				validOrderBody({
					studentId: '24129999',
					fullName: 'Secret Full Name',
					items: [{ productId: product._id.toString(), quantity: 1 }],
					expectedTotal: 10000
				})
			);
		expect(createRes.status).toBe(201);

		const res = await request(app).get(`/api/orders/${createRes.body.data.orderCode}`);

		expect(res.status).toBe(200);
		expect(res.body.data).not.toHaveProperty('studentId');
		expect(res.body.data).not.toHaveProperty('fullName');
		// The rest of the shape stays intact.
		expect(res.body.data).toHaveProperty('orderCode');
		expect(res.body.data).toHaveProperty('totalAmount', 10000);
		expect(res.body.data).toHaveProperty('status');
		expect(res.body.data).toHaveProperty('items');
	});

	it('returns 404 for an unknown order code', async () => {
		const res = await request(app).get('/api/orders/ZZZZZ');
		expect(res.status).toBe(404);
	});
});
