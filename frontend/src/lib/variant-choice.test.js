import { describe, it, expect } from 'vitest';
import {
	chosenVariant,
	emptyChoice,
	formatPriceRange,
	hasOptions,
	isValueAvailable,
	matchingVariants,
	pickValue,
	priceRange,
} from './variant-choice';

const product = {
	price: 100,
	options: [
		{ name: 'Màu', values: ['Đỏ', 'Xanh'] },
		{ name: 'Size', values: ['M', 'L'] },
	],
	// Xanh / L is not offered (inactive variants are not sent to customers).
	variants: [
		{ _id: 'v1', optionValues: ['Đỏ', 'M'], label: 'Đỏ / M', effectivePrice: 100 },
		{ _id: 'v2', optionValues: ['Đỏ', 'L'], label: 'Đỏ / L', effectivePrice: 120, imageUrl: '/uploads/products/a.jpg' },
		{ _id: 'v3', optionValues: ['Xanh', 'M'], label: 'Xanh / M', effectivePrice: 100 },
	],
};

describe('hasOptions', () => {
	it('is false without options, without a variants field, or on the rollback store', () => {
		expect(hasOptions({ options: [] })).toBe(false);
		expect(hasOptions({})).toBe(false);
		expect(hasOptions(null)).toBe(false);
	});

	it('is true when the product declares options', () => {
		expect(hasOptions(product)).toBe(true);
	});
});

describe('isValueAvailable', () => {
	it('disables a chip no active variant matches with the other picks', () => {
		const choice = ['Xanh', null];
		expect(isValueAvailable(product, choice, 1, 'M')).toBe(true);
		expect(isValueAvailable(product, choice, 1, 'L')).toBe(false);
	});

	it('keeps every offered value available while nothing is picked', () => {
		const choice = emptyChoice(product);
		expect(['Đỏ', 'Xanh'].every((value) => isValueAvailable(product, choice, 0, value))).toBe(true);
		expect(['M', 'L'].every((value) => isValueAvailable(product, choice, 1, value))).toBe(true);
	});

	it('does not let the option own pick disable its siblings', () => {
		expect(isValueAvailable(product, ['Đỏ', null], 0, 'Xanh')).toBe(true);
	});
});

describe('chosenVariant', () => {
	it('is null until every option is picked', () => {
		expect(chosenVariant(product, ['Đỏ', null])).toBeNull();
	});

	it('finds the variant of a full choice', () => {
		expect(chosenVariant(product, ['Đỏ', 'L'])._id).toBe('v2');
	});

	it('is null for a combination that is not offered', () => {
		expect(chosenVariant(product, ['Xanh', 'L'])).toBeNull();
	});

	it('is null for a product without options', () => {
		expect(chosenVariant({ options: [], variants: [] }, [])).toBeNull();
	});
});

describe('pickValue', () => {
	it('sets, replaces and clears one option', () => {
		const first = pickValue([null, null], 0, 'Đỏ');
		expect(first).toEqual(['Đỏ', null]);
		expect(pickValue(first, 0, 'Xanh')).toEqual(['Xanh', null]);
		expect(pickValue(first, 0, 'Đỏ')).toEqual([null, null]);
	});
});

describe('priceRange', () => {
	it('spans all active variants until narrowed', () => {
		expect(priceRange(product, emptyChoice(product))).toEqual({ min: 100, max: 120 });
		expect(priceRange(product, ['Xanh', null])).toEqual({ min: 100, max: 100 });
	});

	it('falls back to the product price without variants', () => {
		expect(priceRange({ price: 50, options: [], variants: [] })).toEqual({ min: 50, max: 50 });
		expect(priceRange({ price: 50, options: [{ name: 'a', values: ['x'] }], variants: [] }, [null])).toEqual({ min: 50, max: 50 });
	});

	it('lists the variants still possible', () => {
		expect(matchingVariants(product, ['Đỏ', null]).map((variant) => variant._id)).toEqual(['v1', 'v2']);
	});
});

describe('formatPriceRange', () => {
	const format = (value) => `${value}đ`;
	it('shows one price when min equals max, a range otherwise', () => {
		expect(formatPriceRange({ min: 1, max: 1 }, format)).toBe('1đ');
		expect(formatPriceRange({ min: 1, max: 2 }, format)).toBe('1đ – 2đ');
	});
});
