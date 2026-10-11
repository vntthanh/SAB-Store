/**
 * Covers the two orderCode collision windows POST /api/orders retries on:
 * generateOrderCode() picking a code an existing order already has (caught
 * by the pre-save findOne check), and the rarer race where two requests
 * generate the same fresh code between that check and the insert — that one
 * only surfaces as a Mongo E11000 from Order.save().
 */
// routes/orders.js destructures generateOrderCode when it loads, so the spy has
// to be installed on the helpers module before the app (and with it that route)
// is required. vi.mock cannot do this: it never intercepts native require().
const helpers = require('../../utils/helpers');
const generateOrderCode = vi.spyOn(helpers, 'generateOrderCode');

const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeOrder } = require('../helpers/factories');
const { ensureMovementStore, failNextOrderInsertAsDuplicateCode } = require('../helpers/db');

describe('POST /api/orders — orderCode collision retry', () => {
	let app;

	beforeAll(async () => {
		app = buildTestApp();
		// The first insert into a collection that does not exist yet aborts the
		// surrounding transaction with a retryable WriteConflict, and that retry
		// would draw an extra order code the mocked sequence below does not cover.
		await ensureMovementStore();
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

	it('retries when Order.save() rejects with E11000 (findOne saw no conflict, save raced with another insert)', async () => {
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
});
