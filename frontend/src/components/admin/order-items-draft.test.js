import { describe, it, expect } from 'vitest';
import { toDraft, draftSignature, draftToPayloadItems, activeVariants, hasOptions } from './order-items-draft';

describe('order items draft', () => {
	it('keeps two variants of one product as separate lines', () => {
		const draft = toDraft([
			{ productId: 'p1', variantId: 'v1', productName: 'Áo', variantLabel: 'Đỏ / M', quantity: 1 },
			{ productId: 'p1', variantId: 'v2', productName: 'Áo', variantLabel: 'Xanh / M', quantity: 2 },
		]);
		expect(draft).toHaveLength(2);
	});

	it('merges combo and loose lines of the same variant', () => {
		const draft = toDraft([
			{ productId: { _id: 'p1' }, variantId: 'v1', productName: 'Áo', quantity: 1, fromCombo: true },
			{ productId: 'p1', variantId: 'v1', productName: 'Áo', quantity: 2 },
		]);
		expect(draft).toHaveLength(1);
		expect(draft[0].quantity).toBe(3);
	});

	it('merges lines of a product without a variant and omits variantId from the payload', () => {
		const draft = toDraft([
			{ productId: 'p2', productName: 'Bánh', quantity: 1 },
			{ productId: 'p2', productName: 'Bánh', quantity: 1 },
		]);
		expect(draftToPayloadItems(draft)).toEqual([{ productId: 'p2', quantity: 2 }]);
	});

	it('sends variantId for a line that has one', () => {
		const draft = toDraft([{ productId: 'p1', variantId: 'v1', productName: 'Áo', quantity: 1 }]);
		expect(draftToPayloadItems(draft)).toEqual([{ productId: 'p1', variantId: 'v1', quantity: 1 }]);
	});

	it('detects a variant swap at equal quantity', () => {
		const a = toDraft([{ productId: 'p1', variantId: 'v1', productName: 'Áo', quantity: 1 }]);
		const b = toDraft([{ productId: 'p1', variantId: 'v2', productName: 'Áo', quantity: 1 }]);
		expect(draftSignature(a)).not.toBe(draftSignature(b));
	});

	it('offers only active, unarchived variants', () => {
		const product = {
			options: [{ name: 'Màu', values: ['Đỏ'] }],
			variants: [
				{ _id: 'a', isActive: true },
				{ _id: 'b', isActive: false },
				{ _id: 'c', isActive: true, archivedAt: '2026-01-01' },
				{ _id: 'd' },
			],
		};
		expect(hasOptions(product)).toBe(true);
		expect(activeVariants(product).map((v) => v._id)).toEqual(['a', 'd']);
	});
});
