/**
 * computeOrderPricing as the single price engine: optimal multi-combo
 * application, determinism, the order-size caps, and the stored comboInfo
 * shape every reader must understand.
 */
const { computeOrderPricing, PricingError, MAX_UNITS_PER_ORDER } = require('../../services/pricing');
const { comboRefsOf } = require('../../scripts/audit-combo-pricing');
const { makeProduct, makeCombo } = require('../helpers/factories');

const ONLINE = { channel: 'online' };
const OFFLINE = { channel: 'offline' };
const line = (product, quantity = 1) => ({ productId: product._id.toString(), quantity });

describe('computeOrderPricing — optimal combos', () => {
	// The shapes of the two live combos; unit prices are illustrative.
	async function liveShop() {
		const string = await makeProduct({ category: 'string', price: 30000 });
		const tag = await makeProduct({ category: 'tag', price: 20000 });
		const stringTag = await makeCombo({
			name: 'String and tag',
			price: 45000,
			categoryRequirements: [{ category: 'string', quantity: 1 }, { category: 'tag', quantity: 1 }]
		});
		const tagThree = await makeCombo({
			name: 'Three tags',
			price: 35000,
			categoryRequirements: [{ category: 'tag', quantity: 3 }]
		});
		return { string, tag, stringTag, tagThree };
	}

	it('prices the live combo shapes the way a hand calculation does', async () => {
		const { string, tag } = await liveShop();

		// 1 string + 3 tags: three-tags combo (saves 25000) beats string-and-tag (saves 5000).
		const a = await computeOrderPricing([line(string, 1), line(tag, 3)], ONLINE);
		expect(a.totalAmount).toBe(65000);
		expect(a.savings).toBe(25000);

		// 2 strings + 4 tags: one of each combo = 45000 + 35000 + 30000 string.
		const b = await computeOrderPricing([line(string, 2), line(tag, 4)], ONLINE);
		expect(b.totalAmount).toBe(110000);
		expect(b.comboInfo.combos.map((c) => [c.comboName, c.applications]).sort()).toEqual([
			['String and tag', 1],
			['Three tags', 1]
		]);
	});

	// The counter rings up carts that earn two different combos
	it('applies two different combos in one cart on the offline channel', async () => {
		const { string, tag } = await liveShop();

		const result = await computeOrderPricing([line(string, 2), line(tag, 4)], OFFLINE);

		expect(result.comboInfo.combos).toHaveLength(2);
		expect(result.comboInfo.savings).toBe(30000);
		expect(result.originalTotal).toBe(140000);
		expect(result.savings).toBe(30000);
	});

	// The identity the database importer uses to rebuild a stored total.
	it('keeps totalAmount = comboInfo.finalTotal + the non-combo lines', async () => {
		const { string, tag } = await liveShop();

		const result = await computeOrderPricing([line(string, 2), line(tag, 5)], ONLINE);

		const retail = result.orderItems.filter((i) => !i.fromCombo).reduce((s, i) => s + i.price * i.quantity, 0);
		expect(result.comboInfo.finalTotal + retail).toBe(result.totalAmount);
		expect(result.comboInfo.originalTotal - result.comboInfo.finalTotal).toBe(result.comboInfo.savings);
		expect(result.originalTotal - result.totalAmount).toBe(result.savings);
	});

	it('never charges more than retail when a combo costs more than its items', async () => {
		const a = await makeProduct({ category: 'string', price: 10000 });
		await makeCombo({ price: 99999, categoryRequirements: [{ category: 'string', quantity: 1 }] });

		const result = await computeOrderPricing([line(a, 2)], ONLINE);

		expect(result.comboInfo).toBeNull();
		expect(result.totalAmount).toBe(20000);
	});

	it('puts the dearest units of a category into the combo', async () => {
		const cheap = await makeProduct({ category: 'tag', price: 10000 });
		const dear = await makeProduct({ category: 'tag', price: 30000 });
		await makeCombo({ price: 25000, categoryRequirements: [{ category: 'tag', quantity: 1 }] });

		const result = await computeOrderPricing([line(cheap), line(dear)], ONLINE);

		const comboLine = result.orderItems.find((i) => i.fromCombo);
		expect(comboLine.productId.toString()).toBe(dear._id.toString());
		expect(result.totalAmount).toBe(35000);
	});

	it('returns identical orderItems and totals for any ordering of the cart lines', async () => {
		const { string, tag } = await liveShop();
		const tag2 = await makeProduct({ category: 'tag', price: 20000 });
		const lines = [line(string, 2), line(tag, 2), line(tag2, 3)];

		const reference = await computeOrderPricing(lines, ONLINE);
		const referenceItems = JSON.stringify(reference.orderItems);

		for (let i = 0; i < 25; i++) {
			const shuffled = [...lines].sort(() => Math.random() - 0.5);
			const again = await computeOrderPricing(shuffled, ONLINE);
			expect(again.totalAmount).toBe(reference.totalAmount);
			expect(JSON.stringify(again.orderItems)).toBe(referenceItems);
		}
	});
});

describe('computeOrderPricing — caps', () => {
	it(`rejects a cart over ${MAX_UNITS_PER_ORDER} units, counting merged duplicate lines`, async () => {
		const product = await makeProduct();

		await expect(
			computeOrderPricing([line(product, 150), line(product, 51)], ONLINE)
		).rejects.toMatchObject({ code: 'CART_TOO_MANY_UNITS', httpStatus: 400 });
	});

	it(`accepts exactly ${MAX_UNITS_PER_ORDER} units`, async () => {
		const product = await makeProduct({ price: 10 });

		const result = await computeOrderPricing([line(product, MAX_UNITS_PER_ORDER)], ONLINE);

		expect(result.totalAmount).toBe(2000);
	});

	// A cart whose search space exceeds the budget is refused, never priced greedily
	it('rejects a cart whose combo search exceeds the state budget with CART_TOO_COMPLEX', async () => {
		const x = await makeProduct({ category: 'x', price: 1000 });
		const y = await makeProduct({ category: 'y', price: 1000 });
		const z = await makeProduct({ category: 'z', price: 1000 });
		const req = (...categories) => categories.map((category) => ({ category, quantity: 1 }));
		await makeCombo({ price: 1500, categoryRequirements: req('x', 'y') });
		await makeCombo({ price: 1500, categoryRequirements: req('y', 'z') });
		await makeCombo({ price: 1500, categoryRequirements: req('x', 'z') });
		await makeCombo({ price: 2500, categoryRequirements: req('x', 'y', 'z') });
		await makeCombo({ price: 900, categoryRequirements: req('x') });

		const error = await computeOrderPricing([line(x, 5), line(y, 5), line(z, 5)], { ...ONLINE, stateBudget: 10 }).catch((e) => e);

		expect(error).toBeInstanceOf(PricingError);
		expect(error.code).toBe('CART_TOO_COMPLEX');
		expect(error.httpStatus).toBe(400);
	});
});

describe('computeOrderPricing — channel is required', () => {
	it('throws when channel is missing or unknown', async () => {
		const product = await makeProduct();

		await expect(computeOrderPricing([line(product)])).rejects.toThrow(TypeError);
		await expect(computeOrderPricing([line(product)], {})).rejects.toThrow(TypeError);
		await expect(computeOrderPricing([line(product)], { channel: 'pos' })).rejects.toThrow(TypeError);
	});
});

describe('comboInfo shapes (readers)', () => {
	it('reads the single-combo shape of older online orders', () => {
		const comboId = '507f1f77bcf86cd799439011';

		expect(comboRefsOf({ comboId, comboName: 'Old', savings: 5, originalTotal: 10, finalTotal: 5 })).toEqual([
			expect.objectContaining({ comboId })
		]);
	});

	it('reads the multi-combo shape written by the engine', async () => {
		const a = await makeProduct({ category: 'string', price: 30000 });
		const combo = await makeCombo({ price: 20000, categoryRequirements: [{ category: 'string', quantity: 1 }] });

		const { comboInfo } = await computeOrderPricing([line(a)], ONLINE);

		const refs = comboRefsOf(comboInfo);
		expect(refs).toHaveLength(1);
		expect(String(refs[0].comboId)).toBe(String(combo._id));
	});

	it('returns no refs for an empty or comboless record', () => {
		expect(comboRefsOf({})).toEqual([]);
		expect(comboRefsOf({ combos: [] })).toEqual([]);
	});
});
