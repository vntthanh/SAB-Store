import { describe, it, expect } from 'vitest';
import { lineKey, linesNamedByError, lineTitle, toRequestItem } from './cart-line';

describe('lineKey', () => {
	it('keeps a product without a variant on the trailing-colon key', () => {
		expect(lineKey({ productId: 'p1' })).toBe('p1:');
		expect(lineKey({ productId: 'p1', variantId: null })).toBe('p1:');
	});

	it('separates the variants of one product', () => {
		expect(lineKey({ productId: 'p1', variantId: 'a' })).not.toBe(lineKey({ productId: 'p1', variantId: 'b' }));
	});
});

describe('toRequestItem', () => {
	it('omits variantId for a product without options', () => {
		expect(toRequestItem({ productId: 'p1', quantity: 2, productName: 'x' })).toEqual({ productId: 'p1', quantity: 2 });
	});

	it('sends variantId for a variant line', () => {
		expect(toRequestItem({ productId: 'p1', variantId: 'v1', quantity: 1 })).toEqual({
			productId: 'p1',
			variantId: 'v1',
			quantity: 1,
		});
	});
});

describe('linesNamedByError', () => {
	const items = [
		{ productId: 'p1', variantId: 'a', quantity: 1 },
		{ productId: 'p1', variantId: 'b', quantity: 1 },
		{ productId: 'p2', quantity: 1 },
	];

	it('drops exactly the named variant and keeps its siblings', () => {
		expect(linesNamedByError(items, { lines: [{ productId: 'p1', variantId: 'a' }] })).toEqual([items[0]]);
	});

	it('matches a product line the server names without a variant', () => {
		expect(linesNamedByError(items, { lines: [{ productId: 'p2', variantId: null }] })).toEqual([items[2]]);
	});

	it('names nothing when details are missing or malformed', () => {
		expect(linesNamedByError(items, undefined)).toEqual([]);
		expect(linesNamedByError(items, { lines: 'x' })).toEqual([]);
		expect(linesNamedByError(items, { lines: [null, {}] })).toEqual([]);
	});
});

describe('lineTitle', () => {
	it('appends the label when there is one', () => {
		expect(lineTitle({ productName: 'Áo', variantLabel: 'Đỏ / M' })).toBe('Áo (Đỏ / M)');
		expect(lineTitle({ productName: 'Áo' })).toBe('Áo');
	});
});
