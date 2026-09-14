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
