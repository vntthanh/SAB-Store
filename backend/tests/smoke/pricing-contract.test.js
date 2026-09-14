const { computeOrderPricing, PricingError } = require('../../services/pricing');

describe('pricing contract', () => {
	it('refuses an empty cart instead of returning a zero total', async () => {
		// The contract's central guarantee: a zero total is indistinguishable
		// from a free order, so an empty cart must throw rather than return one.
		await expect(computeOrderPricing([])).rejects.toMatchObject({
			code: 'EMPTY_CART',
			httpStatus: 400,
		});
	});

	it('exposes a PricingError that always maps to HTTP 400', () => {
		const err = new PricingError('EMPTY_CART', { missingIds: ['abc'] });
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe('EMPTY_CART');
		expect(err.httpStatus).toBe(400);
		expect(err.details).toEqual({ missingIds: ['abc'] });
	});
});
