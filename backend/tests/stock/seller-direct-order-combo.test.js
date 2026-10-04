/**
 * Cart-input handling through the shared pricing engine: duplicate lines for
 * one product must merge (stock and money agree with the units bought), and an
 * uppercase-hex product id must resolve to the same product.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeAdminSession } = require('../helpers/factories');
const { applyPendingMovements } = require('../helpers/stock');
const Product = require('../../models/Product');
const Order = require('../../models/Order');

describe('POST /api/seller/orders/direct — cart input handling', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app)); // admin role passes authenticateSeller too
	});

	// Two cart lines for one product used to be priced separately, so the
	// combo's consumption was subtracted from only one of them — billing
	// combo(2) + individual(1) and deducting 3 units for a 2-unit cart.
	it('deducts exactly the units bought when the cart has two lines for the same product', async () => {
		const combo = await makeCombo({
			name: 'Duplicate Line Combo',
			price: 15000,
			categoryRequirements: [{ category: 'dup-line-test', quantity: 2 }]
		});
		const product = await makeProduct({ category: 'dup-line-test', price: 10000, stockQuantity: 10 });

		const res = await request(app)
			.post('/api/seller/orders/direct')
			.set('Cookie', cookies)
			.send({
				items: [
					{ productId: String(product._id), quantity: 1 },
					{ productId: String(product._id), quantity: 1 }
				],
				expectedTotal: 15000
			});

		expect(res.status).toBe(201);

		const totalQuantity = res.body.data.items.reduce((sum, item) => sum + item.quantity, 0);
		expect(totalQuantity).toBe(2); // exactly the 2 units the cart asked for, not 3

		await applyPendingMovements();
		const afterProduct = await Product.findById(product._id);
		expect(afterProduct.stockQuantity).toBe(8); // 10 - 2, never 10 - 3

		const saved = await Order.findOne({ orderCode: res.body.data.orderCode });
		const savedQuantity = saved.items.reduce((sum, item) => sum + item.quantity, 0);
		expect(savedQuantity).toBe(2);
		expect(saved.totalAmount).toBe(15000); // the combo price, not combo(15000) + individual(10000)
	});

	// Mongo matches an uppercase-hex id but `_id.toString()` is lowercase; the
	// engine must canonicalise before comparing or a valid sale looks unknown.
	it('accepts an uppercase hex productId on a direct sale', async () => {
		const product = await makeProduct({ price: 20000, stockQuantity: 5 });

		const res = await request(app)
			.post('/api/seller/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [{ productId: String(product._id).toUpperCase(), quantity: 1 }], expectedTotal: 20000 });

		expect(res.status).toBe(201);

		await applyPendingMovements();
		const afterProduct = await Product.findById(product._id);
		expect(afterProduct.stockQuantity).toBe(4);
	});

});

// POST /api/combos/pricing is public and uses the same engine: an uppercase-hex
// id (accepted by isMongoId and by Mongo's $in) must not drop the cart line.
describe('POST /api/combos/pricing — id casing', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('does not drop a cart line whose productId is uppercase hex', async () => {
		const product = await makeProduct({ price: 20000, stockQuantity: 5 });
		const uppercaseId = String(product._id).toUpperCase();

		const res = await request(app)
			.post('/api/combos/pricing')
			.send({ items: [{ productId: uppercaseId, quantity: 1 }] });

		expect(res.status).toBe(200);
		expect(res.body.data.orderItems).toHaveLength(1);
		expect(res.body.data.orderItems[0].productId).toBe(String(product._id));
		expect(res.body.data.totalAmount).toBe(20000);
	});
});
