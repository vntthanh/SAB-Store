/**
 * POST /api/seller/orders/direct — ComboService duplicate-line and
 * id-casing defects (F3, F4).
 *
 * Both bugs live in services/ComboService.js#calculateOptimalPricing, which
 * only this route uses (the public order route goes through
 * services/pricing.js#computeOrderPricing instead, which already merges
 * duplicate lines and normalizes id casing — see its doc comment).
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeAdminSession } = require('../helpers/factories');
const Product = require('../../models/Product');
const Order = require('../../models/Order');

describe('POST /api/seller/orders/direct — ComboService input handling', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app)); // admin role passes authenticateSeller too
	});

	// F3 — remainingProducts.find(p => p.productId === item.productId) in
	// applyComboToProducts always returns the FIRST entry for a given
	// productId. Two cart lines for the same product used to keep two
	// separate entries, so the combo's consumption was subtracted from only
	// the first entry while the second entry's full quantity survived —
	// billing combo(2) + individual(1) and deducting 3 units for a 2-unit cart.
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
				]
			});

		expect(res.status).toBe(201);

		const totalQuantity = res.body.data.items.reduce((sum, item) => sum + item.quantity, 0);
		expect(totalQuantity).toBe(2); // exactly the 2 units the cart asked for, not 3

		const afterProduct = await Product.findById(product._id);
		expect(afterProduct.stockQuantity).toBe(8); // 10 - 2, never 10 - 3

		const saved = await Order.findOne({ orderCode: res.body.data.orderCode });
		const savedQuantity = saved.items.reduce((sum, item) => sum + item.quantity, 0);
		expect(savedQuantity).toBe(2);
		expect(saved.totalAmount).toBe(15000); // the combo price, not combo(15000) + individual(10000)
	});

	// The route validates every productId up front before pricing. It compared
	// the raw client string against a Set built from `p._id.toString()`, which is
	// always canonical lowercase — so an uppercase id that Mongo had just matched
	// was reported back as a product that does not exist, rejecting a valid sale.
	it('accepts an uppercase hex productId on a direct sale', async () => {
		const product = await makeProduct({ price: 20000, stockQuantity: 5 });

		const res = await request(app)
			.post('/api/seller/orders/direct')
			.set('Cookie', cookies)
			.send({ items: [{ productId: String(product._id).toUpperCase(), quantity: 1 }] });

		expect(res.status).toBe(201);

		const afterProduct = await Product.findById(product._id);
		expect(afterProduct.stockQuantity).toBe(4);
	});

});

// F4 — Product.find({_id:{$in:...}}) accepts an uppercase-hex productId
// (Mongo casts $in case-insensitively), and express-validator's isMongoId()
// (middleware/validation.js#validateComboItems, guarding this public route)
// does too — but ComboService's strict `p._id.toString() === item.productId`
// compare did not, silently dropping the line via
// `.filter(item => item.product)`. POST /api/combos/pricing calls
// ComboService.getPricingBreakdown() with no other id-casing gate in front of
// it (unlike the seller direct-sale route, which separately 400s on an
// uppercase id before ever reaching ComboService), so this is the direct,
// publicly-reachable repro path for the ComboService defect itself.
describe('POST /api/combos/pricing — ComboService id-casing (F4)', () => {
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
		expect(res.body.data.individualItems).toHaveLength(1);
		expect(res.body.data.individualItems[0].subtotal).toBe(20000);
		expect(res.body.data.summary.finalTotal).toBe(20000);
	});
});
