/**
 * Direct unit tests for the two fixes in models/Combo.js and
 * services/ComboService.js that computeOrderPricing relies on:
 *
 *  - Combo.getMaxApplications must return 0 (not the next requirement's
 *    count) when any required category is entirely missing.
 *  - ComboService.applyComboToProducts must refuse to silently under-charge
 *    when the items actually consumed don't match what maxApplications says
 *    they should be.
 */
const Combo = require('../../models/Combo');
const ComboService = require('../../services/ComboService');
const { makeProduct, makeCombo } = require('../helpers/factories');

describe('Combo.getMaxApplications', () => {
	it('returns 0 when a required category has 0 available, even if another requirement has plenty', async () => {
		const combo = await makeCombo({
			categoryRequirements: [
				{ category: 'lanyard', quantity: 1 },
				{ category: 'sticker', quantity: 1 }
			]
		});
		const sticker = await makeProduct({ category: 'sticker', price: 100 });

		const cartLines = [{ productId: sticker._id.toString(), product: sticker, quantity: 3 }];

		expect(combo.getMaxApplications(cartLines)).toBe(0);
	});

	it('returns the limiting requirement\'s count when all categories are present', async () => {
		const combo = await makeCombo({
			categoryRequirements: [
				{ category: 'lanyard', quantity: 1 },
				{ category: 'sticker', quantity: 2 }
			]
		});
		const lanyard = await makeProduct({ category: 'lanyard', price: 100 });
		const sticker = await makeProduct({ category: 'sticker', price: 50 });

		const cartLines = [
			{ productId: lanyard._id.toString(), product: lanyard, quantity: 5 }, // allows 5 applications
			{ productId: sticker._id.toString(), product: sticker, quantity: 4 } // allows 2 applications (4/2)
		];

		expect(combo.getMaxApplications(cartLines)).toBe(2);
	});

	// F11 — two separate requirement entries on the same category (instead of
	// one entry with the summed quantity) used to be evaluated independently
	// against that category's full available quantity, double-counting
	// availability: 3 hats independently satisfies two separate 1x"hat"
	// requirements (floor(3/1)=3 each), so this returned 3 even though 2
	// applications would need 4 hats total. ComboService.applyComboToProducts
	// then tried to actually consume 6 hats from a cart with only 3, and its
	// own post-condition check threw a plain Error — a 500 on checkout.
	it('merges two requirements on the same category instead of double-counting availability', async () => {
		const combo = await makeCombo({
			categoryRequirements: [
				{ category: 'hat', quantity: 1 },
				{ category: 'hat', quantity: 1 }
			]
		});
		const hat = await makeProduct({ category: 'hat', price: 100 });

		const cartLines = [{ productId: hat._id.toString(), product: hat, quantity: 3 }];

		// Needs 2 hats per application (1+1); 3 available → floor(3/2) = 1, not 3.
		expect(combo.getMaxApplications(cartLines)).toBe(1);
	});

	it('applies a same-category-requirement combo without throwing, consuming exactly what it needs', async () => {
		const combo = await makeCombo({
			price: 10,
			categoryRequirements: [
				{ category: 'hat', quantity: 1 },
				{ category: 'hat', quantity: 1 }
			]
		});
		const hat = await makeProduct({ category: 'hat', price: 100 });
		const cartLines = [{ productId: hat._id.toString(), product: hat, quantity: 3 }];

		const maxApplications = combo.getMaxApplications(cartLines);
		const comboAnalysis = { combo, maxApplications };

		// A single call: applyComboToProducts mutates cartLines' item objects
		// in place (decrementing quantity as it consumes), so invoking it
		// twice against the same cartLines would double-consume and give a
		// false read on the second call.
		const result = ComboService.applyComboToProducts(comboAnalysis, cartLines);
		expect(result.applicationsUsed).toBe(1);
		expect(result.itemsUsed.reduce((sum, i) => sum + i.quantity, 0)).toBe(2);
		expect(result.remainingProducts.reduce((sum, i) => sum + i.quantity, 0)).toBe(1);
	});
});

describe('ComboService.applyComboToProducts', () => {
	it('throws instead of under-charging when actual consumption does not match maxApplications', async () => {
		const combo = await makeCombo({
			price: 10,
			categoryRequirements: [{ category: 'sticker', quantity: 2 }]
		});
		const sticker = await makeProduct({ category: 'sticker', price: 100 });

		// Only 4 units available (2 applications worth), but the analysis
		// claims 3 applications (needs 6) — simulates maxApplications drifting
		// out of sync with the cart, which the post-condition must catch.
		const cartLines = [{ productId: sticker._id.toString(), product: sticker, quantity: 4 }];
		const comboAnalysis = { combo, maxApplications: 3 };

		expect(() => ComboService.applyComboToProducts(comboAnalysis, cartLines)).toThrow();
	});

	it('applies cleanly when maxApplications matches what the cart can actually supply', async () => {
		const combo = await makeCombo({
			price: 10,
			categoryRequirements: [{ category: 'sticker', quantity: 2 }]
		});
		const sticker = await makeProduct({ category: 'sticker', price: 100 });

		const cartLines = [{ productId: sticker._id.toString(), product: sticker, quantity: 4 }];
		const comboAnalysis = { combo, maxApplications: 2 };

		const result = ComboService.applyComboToProducts(comboAnalysis, cartLines);

		expect(result.applicationsUsed).toBe(2);
		expect(result.itemsUsed.reduce((sum, i) => sum + i.quantity, 0)).toBe(4);
		expect(result.remainingProducts).toHaveLength(0);
	});
});
