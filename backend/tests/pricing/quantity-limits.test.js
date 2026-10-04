/**
 * min/maxOrderQuantity as enforced by computeOrderPricing when an order route
 * asks for it. Without a limit nothing stops one anonymous order from taking a
 * product's whole stock.
 */
const { computeOrderPricing } = require('../../services/pricing');
const { makeProduct } = require('../helpers/factories');

const online = (extra = {}) => ({ channel: 'online', enforceQuantityLimits: true, ...extra });
const offline = (extra = {}) => ({ channel: 'offline', enforceQuantityLimits: true, ...extra });
const cart = (product, quantity) => [{ productId: String(product._id), quantity }];

describe('computeOrderPricing — quantity limits', () => {
	it('does not check limits unless asked, so previews still price an over-limit cart', async () => {
		const product = await makeProduct({ minOrderQuantity: 3, maxOrderQuantity: 5 });

		await expect(computeOrderPricing(cart(product, 1), { channel: 'offline' })).resolves.toMatchObject({ overMaxLines: [] });
		await expect(computeOrderPricing(cart(product, 9), { channel: 'offline' })).resolves.toMatchObject({ overMaxLines: [] });
	});

	it.each([['online', online], ['offline', offline]])('rejects a quantity below the minimum on %s, even when over-max is allowed', async (_name, opts) => {
		const product = await makeProduct({ name: 'Min Three', minOrderQuantity: 3 });

		await expect(computeOrderPricing(cart(product, 2), opts({ allowOverMax: true }))).rejects.toMatchObject({
			code: 'QUANTITY_OUT_OF_RANGE',
			httpStatus: 400,
			details: { productId: String(product._id), min: 3, quantity: 2, reason: 'below_min' }
		});
	});

	it('sums duplicate lines before comparing with the limits', async () => {
		const product = await makeProduct({ maxOrderQuantity: 4 });

		await expect(computeOrderPricing(
			[{ productId: String(product._id), quantity: 2 }, { productId: String(product._id), quantity: 3 }],
			online()
		)).rejects.toMatchObject({ code: 'QUANTITY_OUT_OF_RANGE' });
	});

	it('accepts the exact minimum and the exact maximum', async () => {
		const product = await makeProduct({ minOrderQuantity: 2, maxOrderQuantity: 4 });

		await expect(computeOrderPricing(cart(product, 2), online())).resolves.toBeDefined();
		await expect(computeOrderPricing(cart(product, 4), online())).resolves.toBeDefined();
	});

	it('treats a product with no maximum as unlimited up to the per-order cap', async () => {
		const product = await makeProduct({ maxOrderQuantity: null });

		await expect(computeOrderPricing(cart(product, 150), online())).resolves.toBeDefined();
	});

	it('rejects over the maximum online with 400, and ignores allowOverMax there', async () => {
		const product = await makeProduct({ name: 'Max Four', maxOrderQuantity: 4 });

		await expect(computeOrderPricing(cart(product, 5), online({ allowOverMax: true }))).rejects.toMatchObject({
			code: 'QUANTITY_OUT_OF_RANGE',
			httpStatus: 400,
			details: { max: 4, quantity: 5, reason: 'above_max' }
		});
	});

	it('asks a counter sale over the maximum for confirmation, listing every such line', async () => {
		const a = await makeProduct({ name: 'Alpha', maxOrderQuantity: 2 });
		const b = await makeProduct({ name: 'Beta', maxOrderQuantity: 3 });
		const c = await makeProduct({ name: 'Gamma', maxOrderQuantity: 10 });

		const error = await computeOrderPricing(
			[
				{ productId: String(a._id), quantity: 5 },
				{ productId: String(b._id), quantity: 4 },
				{ productId: String(c._id), quantity: 6 }
			],
			offline()
		).catch((e) => e);

		expect(error).toMatchObject({ code: 'QUANTITY_OVER_MAX', httpStatus: 409 });
		expect(error.details.lines).toEqual(expect.arrayContaining([
			{ productId: String(a._id), productName: 'Alpha', quantity: 5, max: 2 },
			{ productId: String(b._id), productName: 'Beta', quantity: 4, max: 3 }
		]));
		expect(error.details.lines).toHaveLength(2);
	});

	it('lets a confirmed counter sale through and reports the lines that exceeded', async () => {
		const product = await makeProduct({ name: 'Alpha', maxOrderQuantity: 2, price: 1000 });

		const result = await computeOrderPricing(cart(product, 5), offline({ allowOverMax: true }));

		expect(result.totalAmount).toBe(5000);
		expect(result.overMaxLines).toEqual([{ productId: String(product._id), productName: 'Alpha', quantity: 5, max: 2 }]);
	});

	it('still enforces the per-order unit cap on a confirmed counter sale', async () => {
		const product = await makeProduct({ maxOrderQuantity: 2 });

		await expect(computeOrderPricing(cart(product, 201), offline({ allowOverMax: true }))).rejects.toMatchObject({
			code: 'CART_TOO_MANY_UNITS'
		});
	});
});
