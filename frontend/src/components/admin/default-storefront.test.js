import { describe, it, expect } from 'vitest';
import { pickDefaultStorefrontId } from './default-storefront';

describe('pickDefaultStorefrontId', () => {
	it('takes the only storefront, active or not', () => {
		expect(pickDefaultStorefrontId([{ _id: 'a', isActive: false }])).toBe('a');
	});

	it('takes the first active one among several', () => {
		const list = [{ _id: 'a', isActive: false }, { _id: 'b', isActive: true }, { _id: 'c', isActive: true }];
		expect(pickDefaultStorefrontId(list)).toBe('b');
	});

	it('is empty when nothing qualifies', () => {
		expect(pickDefaultStorefrontId([])).toBe('');
		expect(pickDefaultStorefrontId([{ _id: 'a', isActive: false }, { _id: 'b', isActive: false }])).toBe('');
	});
});
