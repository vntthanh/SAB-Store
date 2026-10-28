import { describe, expect, it } from 'vitest';
import { optionCombinations, combinationCount, productVariantSetup, toErrorList, MAX_VARIANT_COMBINATIONS } from '../src/index.js';

const messagesOf = (body) => {
	const result = productVariantSetup.safeParse(body);
	return result.success ? [] : toErrorList(result.error.issues, body).map((error) => error.message);
};

const sizes = { name: 'Size', values: ['S', 'M'] };
const colors = { name: 'Màu', values: ['Đỏ', 'Xanh'] };

describe('optionCombinations', () => {
	it('lists one value per option in option order, and one empty combination without options', () => {
		expect(optionCombinations([colors, sizes])).toEqual([['Đỏ', 'S'], ['Đỏ', 'M'], ['Xanh', 'S'], ['Xanh', 'M']]);
		expect(optionCombinations([])).toEqual([[]]);
		expect(combinationCount([colors, sizes, { name: 'Kiểu', values: ['a', 'b', 'c'] }])).toBe(12);
	});
});

describe('productVariantSetup', () => {
	const every = (options, extra = {}) => optionCombinations(options).map((optionValues) => ({ optionValues, ...extra }));

	it('accepts every combination exactly once, and a single default variant without options', () => {
		expect(messagesOf({ images: ['/uploads/products/a.jpg'], options: [colors, sizes], variants: every([colors, sizes]) })).toEqual([]);
		expect(messagesOf({ options: [], variants: [{ optionValues: [], price: null, openingStock: 3 }] })).toEqual([]);
		expect(messagesOf({ images: [] })).toEqual([]);
	});

	it('refuses a missing, extra or repeated combination', () => {
		const all = every([colors, sizes]);
		expect(messagesOf({ options: [colors, sizes], variants: all.slice(1) })).toContain('Thiếu tổ hợp phân loại');
		expect(messagesOf({ options: [colors, sizes], variants: [...all, { optionValues: ['Vàng', 'S'] }] })).toContain('Tổ hợp không khớp các phân loại');
		expect(messagesOf({ options: [colors, sizes], variants: [...all.slice(1), all[1]] })).toContain('Tổ hợp bị trùng');
	});

	it('refuses repeated option names or values, options without variants, and more combinations than the cap', () => {
		expect(messagesOf({ options: [sizes, { ...sizes }], variants: [] })).toContain('Tên phân loại bị trùng');
		expect(messagesOf({ options: [{ name: 'Size', values: ['S', 'S'] }], variants: [] })).toContain('Giá trị phân loại bị trùng');
		expect(messagesOf({ options: [sizes] })).toContain('Phân loại và tổ hợp phải gửi cùng nhau');
		const many = [{ name: 'A', values: Array.from({ length: 11 }, (_, i) => `a${i}`) }, { name: 'B', values: Array.from({ length: 10 }, (_, i) => `b${i}`) }];
		expect(messagesOf({ options: many, variants: [] }).join()).toMatch(new RegExp(`Tối đa ${MAX_VARIANT_COMBINATIONS} tổ hợp`));
	});

	it('refuses a variant image outside the gallery, a negative price, repeated SKUs, ten images and a non-web image', () => {
		expect(messagesOf({ images: ['/uploads/products/a.jpg'], options: [sizes], variants: [{ optionValues: ['S'], imageUrl: '/uploads/products/b.jpg' }, { optionValues: ['M'] }] }))
			.toContain('Ảnh của tổ hợp phải là một ảnh của sản phẩm');
		expect(messagesOf({ options: [sizes], variants: [{ optionValues: ['S'], price: -1 }, { optionValues: ['M'] }] })).toContain('Giá phân loại phải là số nguyên không âm (VND)');
		expect(messagesOf({ options: [sizes], variants: [{ optionValues: ['S'], sku: 'X' }, { optionValues: ['M'], sku: 'X' }] })).toContain('SKU bị trùng');
		expect(messagesOf({ images: Array.from({ length: 10 }, (_, i) => `/uploads/products/${i}.jpg`) })).toContain('Tối đa 9 ảnh');
		for (const url of ['javascript:alert(1)', '//evil.example/x.png', '/uploads/receipts/x.png', '/uploads/products/../x', '/etc/passwd']) {
			expect(messagesOf({ images: [url] }), url).toContain('Đường dẫn ảnh không hợp lệ');
		}
		expect(messagesOf({ images: ['/uploads/products/image-1.jpg', 'https://cdn.example/a.png'] })).toEqual([]);
	});

	it('needs at least one variant on sale', () => {
		expect(messagesOf({ options: [sizes], variants: every([sizes], { isActive: false }) })).toContain('Cần ít nhất một tổ hợp đang bán');
	});
});
