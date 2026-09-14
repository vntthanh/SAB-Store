/**
 * Unit tests for services/pricing.js — the single source of order totals.
 *
 * Exercises computeOrderPricing() directly (no HTTP layer) so each pricing
 * rule can be pinned down precisely: availability, merging, normalization,
 * and the combo bug fix (a combo must not apply when only some of its
 * required categories are satisfied).
 */
const mongoose = require('mongoose');
const { computeOrderPricing, PricingError } = require('../../services/pricing');
const { makeProduct, makeCombo } = require('../helpers/factories');

describe('computeOrderPricing', () => {
	it('throws EMPTY_CART for an empty items array, never a zero total', async () => {
		await expect(computeOrderPricing([])).rejects.toMatchObject({
			name: 'PricingError',
			code: 'EMPTY_CART',
			httpStatus: 400
		});
	});

	it('throws EMPTY_CART when items is missing/not an array', async () => {
		await expect(computeOrderPricing(undefined)).rejects.toThrow(PricingError);
		await expect(computeOrderPricing(null)).rejects.toThrow(PricingError);
	});

	it('computes totalAmount from DB prices, ignoring anything client-shaped', async () => {
		const product = await makeProduct({ price: 75000 });

		const result = await computeOrderPricing([
			{ productId: product._id.toString(), quantity: 3 }
		]);

		expect(result.totalAmount).toBe(225000);
		expect(result.orderItems).toHaveLength(1);
		expect(result.orderItems[0].price).toBe(75000);
		expect(result.orderItems[0].quantity).toBe(3);
		// productId must be an ObjectId, not a string, so it writes to Order
		// without re-casting.
		expect(result.orderItems[0].productId).toBeInstanceOf(mongoose.Types.ObjectId);
		expect(result.orderItems[0].productId.toString()).toBe(product._id.toString());
		expect(result.comboInfo).toBeNull();
	});

	it('exposes loaded product documents keyed by productId.toString()', async () => {
		const product = await makeProduct();

		const result = await computeOrderPricing([{ productId: product._id.toString(), quantity: 1 }]);

		expect(result.products).toBeInstanceOf(Map);
		expect(result.products.get(product._id.toString())._id.toString()).toBe(product._id.toString());
	});

	it('merges duplicate productId lines instead of rejecting them', async () => {
		const product = await makeProduct({ price: 10000 });

		const result = await computeOrderPricing([
			{ productId: product._id.toString(), quantity: 2 },
			{ productId: product._id.toString(), quantity: 5 }
		]);

		expect(result.orderItems).toHaveLength(1);
		expect(result.orderItems[0].quantity).toBe(7);
		expect(result.totalAmount).toBe(70000);
	});

	it('normalizes uppercase-hex productId so it matches the lowercase DB form', async () => {
		const product = await makeProduct({ price: 20000 });
		const upperId = product._id.toString().toUpperCase();

		const result = await computeOrderPricing([{ productId: upperId, quantity: 1 }]);

		expect(result.totalAmount).toBe(20000);
		expect(result.orderItems[0].productId.toString()).toBe(product._id.toString());
	});

	it('throws PRODUCT_UNAVAILABLE with the missing id when a product does not exist', async () => {
		const missingId = new mongoose.Types.ObjectId().toString();

		await expect(computeOrderPricing([{ productId: missingId, quantity: 1 }])).rejects.toMatchObject({
			code: 'PRODUCT_UNAVAILABLE',
			details: { missingIds: [missingId] }
		});
	});

	it('throws PRODUCT_UNAVAILABLE for a product with available:false', async () => {
		const product = await makeProduct({ available: false });

		await expect(
			computeOrderPricing([{ productId: product._id.toString(), quantity: 1 }])
		).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
	});

	it('throws PRODUCT_UNAVAILABLE for a product with isActive:false even if available:true', async () => {
		// Availability is one rule (isActive AND available), matching
		// Product.findAvailable() — there is no flag to relax it.
		const product = await makeProduct({ isActive: false, available: true });

		await expect(
			computeOrderPricing([{ productId: product._id.toString(), quantity: 1 }])
		).rejects.toMatchObject({ code: 'PRODUCT_UNAVAILABLE' });
	});

	it('throws INVALID_QUANTITY for a zero or negative quantity', async () => {
		const product = await makeProduct();

		await expect(
			computeOrderPricing([{ productId: product._id.toString(), quantity: 0 }])
		).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });

		await expect(
			computeOrderPricing([{ productId: product._id.toString(), quantity: -1 }])
		).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
	});

	describe('combo application', () => {
		it('applies a combo when every required category is satisfied', async () => {
			const a = await makeProduct({ category: 'lanyard', price: 100000 });
			const b = await makeProduct({ category: 'sticker', price: 50000 });
			const combo = await makeCombo({
				price: 120000,
				categoryRequirements: [
					{ category: 'lanyard', quantity: 1 },
					{ category: 'sticker', quantity: 1 }
				]
			});

			const result = await computeOrderPricing([
				{ productId: a._id.toString(), quantity: 1 },
				{ productId: b._id.toString(), quantity: 1 }
			]);

			expect(result.comboInfo).not.toBeNull();
			expect(result.comboInfo.comboId.toString()).toBe(combo._id.toString());
			expect(result.comboInfo.originalTotal).toBe(150000);
			expect(result.comboInfo.finalTotal).toBe(120000);
			expect(result.comboInfo.savings).toBe(30000);
			expect(result.totalAmount).toBe(120000);
			expect(result.orderItems.every((item) => item.fromCombo)).toBe(true);
		});

		it('does NOT apply a 2-category combo when the cart only satisfies 1 category', async () => {
			// This is the core bug from the audit: Combo.getMaxApplications used
			// to seed its running minimum at 0 instead of Infinity, so a missing
			// category (0 available) was overwritten by the next requirement's
			// count instead of pinning the result at 0.
			const b1 = await makeProduct({ category: 'sticker', price: 100 });
			const b2 = await makeProduct({ category: 'sticker', price: 100 });
			const b3 = await makeProduct({ category: 'sticker', price: 100 });
			await makeCombo({
				price: 50,
				categoryRequirements: [
					{ category: 'lanyard', quantity: 1 }, // cart has 0 of this category
					{ category: 'sticker', quantity: 1 }
				]
			});

			const result = await computeOrderPricing([
				{ productId: b1._id.toString(), quantity: 1 },
				{ productId: b2._id.toString(), quantity: 1 },
				{ productId: b3._id.toString(), quantity: 1 }
			]);

			expect(result.comboInfo).toBeNull();
			expect(result.totalAmount).toBe(300); // full price, no combo discount
			expect(result.orderItems.every((item) => !item.fromCombo)).toBe(true);
		});

		it('leaves remaining items outside the combo at individual price', async () => {
			const a = await makeProduct({ category: 'lanyard', price: 100000 });
			const b1 = await makeProduct({ category: 'sticker', price: 50000 });
			const b2 = await makeProduct({ category: 'sticker', price: 50000 });
			await makeCombo({
				price: 120000,
				categoryRequirements: [
					{ category: 'lanyard', quantity: 1 },
					{ category: 'sticker', quantity: 1 }
				]
			});

			const result = await computeOrderPricing([
				{ productId: a._id.toString(), quantity: 1 },
				{ productId: b1._id.toString(), quantity: 1 },
				{ productId: b2._id.toString(), quantity: 1 }
			]);

			// One combo application (a + one sticker) + one sticker left over
			// at full price.
			expect(result.comboInfo.finalTotal).toBe(120000);
			expect(result.totalAmount).toBe(120000 + 50000);
			expect(result.orderItems.some((item) => !item.fromCombo)).toBe(true);
		});

		it('ignores inactive combos', async () => {
			const a = await makeProduct({ category: 'lanyard', price: 100000 });
			const b = await makeProduct({ category: 'sticker', price: 50000 });
			await makeCombo({
				price: 1, // would be hugely beneficial if it applied
				isActive: false,
				categoryRequirements: [
					{ category: 'lanyard', quantity: 1 },
					{ category: 'sticker', quantity: 1 }
				]
			});

			const result = await computeOrderPricing([
				{ productId: a._id.toString(), quantity: 1 },
				{ productId: b._id.toString(), quantity: 1 }
			]);

			expect(result.comboInfo).toBeNull();
			expect(result.totalAmount).toBe(150000);
		});
	});

	describe('opts.session', () => {
		it('accepts a null session (no replica set on production, see plan AD-4)', async () => {
			const product = await makeProduct({ price: 5000 });

			const result = await computeOrderPricing(
				[{ productId: product._id.toString(), quantity: 1 }],
				{ session: null }
			);

			expect(result.totalAmount).toBe(5000);
		});
	});
});
