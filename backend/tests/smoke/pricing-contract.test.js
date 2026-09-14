const { computeOrderPricing, PricingError } = require('../../services/pricing');

describe('pricing contract', () => {
	it('throws NOT_IMPLEMENTED until Phase 05 supplies the implementation', async () => {
		// The stub must fail loudly. Returning a zero total here would let a
		// caller wired up early write free orders without anyone noticing.
		await expect(computeOrderPricing([])).rejects.toThrow('NOT_IMPLEMENTED');
	});

	it('exposes a PricingError that always maps to HTTP 400', () => {
		const err = new PricingError('EMPTY_CART', { missingIds: ['abc'] });
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe('EMPTY_CART');
		expect(err.httpStatus).toBe(400);
		expect(err.details).toEqual({ missingIds: ['abc'] });
	});
});
