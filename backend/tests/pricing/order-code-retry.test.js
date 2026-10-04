/**
 * Covers the orderCode collision POST /api/orders retries on: a generated code
 * that another order already has, or two requests drawing the same fresh code.
 * Both surface as a Mongo E11000 from Order.save(), which aborts the order's
 * transaction, so the whole transaction runs again with a new code.
 */
jest.mock('../../utils/helpers', () => ({
	...jest.requireActual('../../utils/helpers'),
	generateOrderCode: jest.fn()
}));

const request = require('supertest');
const { generateOrderCode } = require('../../utils/helpers');
const { buildTestApp } = require('../helpers/app');
const { makeProduct } = require('../helpers/factories');
const Order = require('../../models/Order');
const StockMovement = require('../../models/StockMovement');

describe('POST /api/orders — orderCode collision retry', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	afterEach(() => {
		generateOrderCode.mockReset();
	});

	it('retries the transaction when the generated code already belongs to an existing order', async () => {
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
				studentId: '24120001',
				fullName: 'Nguyen Van B',
				email: 'b@example.com',
				phoneNumber: '0987654321',
				items: [{ productId: product._id.toString(), quantity: 1 }],
				expectedTotal: 10000
			});

		expect(res.status).toBe(201);
		expect(res.body.data.orderCode).toBe('BBBBB');
	});

	it('retries the transaction when Order.save() rejects with E11000 (a save raced with another insert)', async () => {
		const product = await makeProduct({ price: 5000 });

		generateOrderCode.mockReturnValueOnce('CCCCC').mockReturnValueOnce('DDDDD');

		const originalSave = Order.prototype.save;
		let callCount = 0;
		const saveSpy = jest.spyOn(Order.prototype, 'save').mockImplementation(async function mockedSave(...args) {
			callCount += 1;
			if (callCount === 1) {
				const duplicateKeyError = new Error('E11000 duplicate key error collection: orders index: orderCode_1');
				duplicateKeyError.code = 11000;
				throw duplicateKeyError;
			}
			return originalSave.apply(this, args);
		});

		try {
			const res = await request(app)
				.post('/api/orders')
				.send({
					studentId: '24120002',
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

	it('gives up with 500 after 10 collisions and leaves no order or movement behind', async () => {
		const product = await makeProduct({ price: 5000 });
		await Order.create({
			orderCode: 'EEEEE',
			studentId: 'X',
			fullName: 'X',
			email: 'x@example.com',
			phoneNumber: '0900000000',
			items: [{ productId: product._id, productName: product.name, price: product.price, quantity: 1 }],
			totalAmount: product.price,
			status: 'confirmed',
			statusHistory: [{ status: 'confirmed', updatedBy: 'system' }]
		});
		generateOrderCode.mockReturnValue('EEEEE');

		const res = await request(app)
			.post('/api/orders')
			.send({
				studentId: '24120003',
				fullName: 'Nguyen Van D',
				email: 'd@example.com',
				phoneNumber: '0987654323',
				items: [{ productId: product._id.toString(), quantity: 1 }],
				expectedTotal: 5000
			});

		expect(res.status).toBe(500);
		expect(generateOrderCode).toHaveBeenCalledTimes(10);
		expect(await Order.countDocuments()).toBe(1);
		expect(await StockMovement.countDocuments()).toBe(0);
	});
});
