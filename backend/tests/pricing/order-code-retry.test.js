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
const { makeProduct } = require('../helpers/factories');
const Order = require('../../models/Order');

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

		await Order.create({
			orderCode: 'AAAAA',
			studentId: 'X',
			fullName: 'X',
			email: 'x@example.com',
			phoneNumber: '0900000000',
			items: [{ productId: product._id, productName: product.name, price: product.price, quantity: 1 }],
			totalAmount: product.price,
			status: 'confirmed',
			statusHistory: [{ status: 'confirmed', updatedBy: 'system' }]
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

		const originalSave = Order.prototype.save;
		let callCount = 0;
		const saveSpy = vi.spyOn(Order.prototype, 'save').mockImplementation(async function mockedSave() {
			callCount += 1;
			if (callCount === 1) {
				const duplicateKeyError = new Error('E11000 duplicate key error collection: orders index: orderCode_1');
				duplicateKeyError.code = 11000;
				throw duplicateKeyError;
			}
			return originalSave.call(this);
		});

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
			expect(callCount).toBe(2);
		} finally {
			saveSpy.mockRestore();
		}
	});
});
