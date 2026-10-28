/**
 * Covers the two orderCode collision windows POST /api/orders retries on:
 * generateOrderCode() picking a code an existing order already has (caught
 * by the pre-save findOne check), and the rarer race where two requests
 * generate the same fresh code between that check and the insert — that one
 * only surfaces as a duplicate-key error from the order insert.
 */
// routes/orders.js destructures generateOrderCode when it loads, so the spy has
// to be installed on the helpers module before the app (and with it that route)
// is required. vi.mock cannot do this: it never intercepts native require().
const helpers = require('../../utils/helpers');
const generateOrderCode = vi.spyOn(helpers, 'generateOrderCode');

const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeOrder } = require('../helpers/factories');
const { failNextOrderInsertAsDuplicateCode, failNextOrderInsertAsDuplicateOn, listOrders } = require('../helpers/db');
const { makeAdminSession } = require('../helpers/factories');

describe('POST /api/orders — orderCode collision retry', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	afterEach(() => {
		generateOrderCode.mockReset();
	});

	it('retries when the generated code already belongs to an existing order', async () => {
		const product = await makeProduct({ price: 10000 });

		await makeOrder({
			orderCode: 'AAAAA',
			studentId: 'X',
			fullName: 'X',
			email: 'x@example.com',
			phoneNumber: '0900000000',
			items: [{ productId: product._id, productName: product.name, price: product.price, quantity: 1 }],
			totalAmount: product.price,
			stockDeducted: false
		});

		generateOrderCode.mockReturnValueOnce('AAAAA').mockReturnValueOnce('BBBBB');

		const res = await request(app)
			.post('/api/orders')
			.send({
				studentId: '24120011',
				fullName: 'Nguyen Van B',
				email: 'b@example.com',
				phoneNumber: '0987654321',
				items: [{ productId: product._id.toString(), quantity: 1 }],
				expectedTotal: 10000
			});

		expect(res.status).toBe(201);
		expect(res.body.data.orderCode).toBe('BBBBB');
		expect(generateOrderCode).toHaveBeenCalledTimes(2);
	});

	it('retries when Order.save() rejects with a duplicate-key error (the check saw no conflict, the insert raced with another)', async () => {
		const product = await makeProduct({ price: 5000 });

		generateOrderCode.mockReturnValueOnce('CCCCC').mockReturnValueOnce('DDDDD');

		const duplicateCode = failNextOrderInsertAsDuplicateCode();

		try {
			const res = await request(app)
				.post('/api/orders')
				.send({
					studentId: '24120012',
					fullName: 'Nguyen Van C',
					email: 'c@example.com',
					phoneNumber: '0987654322',
					items: [{ productId: product._id.toString(), quantity: 1 }],
					expectedTotal: 5000
				});

			expect(res.status).toBe(201);
			expect(res.body.data.orderCode).toBe('DDDDD');
			expect(duplicateCode.fired()).toBe(true);
			expect(duplicateCode.calls()).toBe(2);
		} finally {
			duplicateCode.remove();
		}
	});

	it('does not retry a duplicate on another unique column', async () => {
		const product = await makeProduct({ price: 5000 });
		generateOrderCode.mockReturnValueOnce('EEEEE').mockReturnValueOnce('FFFFF');

		const duplicate = failNextOrderInsertAsDuplicateOn('studentId');
		try {
			const res = await request(app)
				.post('/api/orders')
				.send({
					studentId: '24120013',
					fullName: 'Nguyen Van D',
					email: 'd@example.com',
					phoneNumber: '0987654323',
					items: [{ productId: product._id.toString(), quantity: 1 }],
					expectedTotal: 5000
				});

			expect(res.status).toBe(500);
			expect(duplicate.fired()).toBe(true);
			expect(generateOrderCode).toHaveBeenCalledTimes(1);
			expect(await listOrders()).toEqual([]);
		} finally {
			duplicate.remove();
		}
	});
});

describe('POST /api/seller/orders/direct — order number collision retry', () => {
	let app;
	let cookies;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		({ cookies } = await makeAdminSession(app)); // admin role passes authenticateSeller too
	});

	const sell = (product) => request(app)
		.post('/api/seller/orders/direct')
		.set('Cookie', cookies)
		.send({ items: [{ productId: String(product._id), quantity: 1 }], expectedTotal: product.price });

	it.each(['orderNumber', 'orderCode'])('runs the sale again when the insert clashes on %s', async (column) => {
		const product = await makeProduct({ price: 7000 });

		const duplicate = failNextOrderInsertAsDuplicateOn(column);
		try {
			const res = await sell(product);

			expect(res.status).toBe(201);
			expect(duplicate.fired()).toBe(true);
			expect(duplicate.calls()).toBe(2);
			expect(await listOrders()).toHaveLength(1);
		} finally {
			duplicate.remove();
		}
	});

	it('answers 500 without a second attempt when the clash is on another column', async () => {
		const product = await makeProduct({ price: 7000 });

		const duplicate = failNextOrderInsertAsDuplicateOn('fullName');
		try {
			const res = await sell(product);

			expect(res.status).toBe(500);
			expect(duplicate.calls()).toBe(1);
			expect(await listOrders()).toEqual([]);
		} finally {
			duplicate.remove();
		}
	});
});
