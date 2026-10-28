import { z } from '../z.js';
import { wholeNumber } from './primitives.js';

export const MAX_PRODUCT_IMAGES = 9;
export const FALLBACK_PRODUCT_IMAGE = '/fallback-product.png';
// An object this store uploaded for a product; the only kind the server ever deletes.
export const PRODUCT_UPLOAD_PATTERN = /^\/uploads\/products\/[A-Za-z0-9._-]+$/;
export const MAX_VARIANT_COMBINATIONS = 100;
export const MAX_OPTION_VALUES = 50;
export const OPTION_TEXT_MAX = 30;

const IMAGE_URL_MAX = 2000;
// A product upload of this store or a web address: no other path or scheme can
// reach an <img>, or the storage clean-up, through a product.
const WEB_IMAGE_PATTERN = /^https?:\/\/[^/]/i;

const IMAGE_INVALID = 'Đường dẫn ảnh không hợp lệ';
const imageUrl = z
	.string({ error: IMAGE_INVALID })
	.trim()
	.min(1, IMAGE_INVALID)
	.max(IMAGE_URL_MAX, IMAGE_INVALID)
	.refine((url) => PRODUCT_UPLOAD_PATTERN.test(url) || WEB_IMAGE_PATTERN.test(url), IMAGE_INVALID);

const optionText = (what) => z
	.string({ error: `${what} không hợp lệ` })
	.trim()
	.min(1, `${what} không được để trống`)
	.max(OPTION_TEXT_MAX, `${what} tối đa ${OPTION_TEXT_MAX} ký tự`);

/**
 * Every combination of one value per option, in option order: the variants a
 * product with these options has. No options gives the one empty combination
 * (the default variant).
 *
 * @param {Array<{values: string[]}>} options
 * @returns {string[][]}
 */
export function optionCombinations(options) {
	return options.reduce(
		(combinations, option) => combinations.flatMap((combination) => option.values.map((value) => [...combination, value])),
		[[]],
	);
}

/** How many variants these options make, without building them. */
export const combinationCount = (options) => options.reduce((count, option) => count * option.values.length, 1);

const keyOf = (values) => JSON.stringify(values);

const option = z.object({
	name: optionText('Tên phân loại'),
	values: z
		.array(optionText('Giá trị phân loại'), { error: 'Danh sách giá trị không hợp lệ' })
		.min(1, 'Mỗi loại phân loại cần ít nhất một giá trị')
		.max(MAX_OPTION_VALUES, `Mỗi loại phân loại tối đa ${MAX_OPTION_VALUES} giá trị`),
	// What the option and each value were called when the form loaded, so a rename
	// keeps the variants (their ids and stock) instead of replacing them. A new
	// option or value has none.
	previousName: optionText('Tên phân loại cũ').optional(),
	previousValues: z.array(optionText('Giá trị phân loại cũ').nullable()).optional(),
});

const VARIANT_PRICE = 'Giá phân loại phải là số nguyên không âm (VND)';
const variant = z.object({
	optionValues: z.array(optionText('Giá trị phân loại'), { error: 'Phân loại không hợp lệ' }),
	price: wholeNumber({ min: 0, message: VARIANT_PRICE }).nullable().optional(),
	sku: z.string({ error: 'SKU không hợp lệ' }).trim().min(1, 'SKU không được để trống').max(64, 'SKU tối đa 64 ký tự').nullable().optional(),
	imageUrl: imageUrl.nullable().optional(),
	isActive: z.boolean({ error: 'Trạng thái phân loại không hợp lệ' }).optional(),
	// Only read when the product is created: later stock goes through adjustments.
	openingStock: wholeNumber({ min: 0, max: 1_000_000, message: 'Tồn kho ban đầu phải là số nguyên không âm' }).optional(),
});

/**
 * The gallery, options and variants of a product, as the admin form sends them.
 * Each part is optional; `options` and `variants` come together. The rules the
 * form shows before saving are here; the server checks them again with what is
 * stored (renames, history, SKUs of other products).
 */
export const productVariantSetup = z
	.object({
		images: z
			.array(imageUrl, { error: 'Danh sách ảnh không hợp lệ' })
			.max(MAX_PRODUCT_IMAGES, `Tối đa ${MAX_PRODUCT_IMAGES} ảnh`)
			.optional(),
		options: z.array(option, { error: 'Danh sách phân loại không hợp lệ' }).optional(),
		variants: z.array(variant, { error: 'Danh sách tổ hợp không hợp lệ' }).max(MAX_VARIANT_COMBINATIONS, `Tối đa ${MAX_VARIANT_COMBINATIONS} tổ hợp`).optional(),
	})
	.superRefine((setup, ctx) => {
		const issue = (message, path) => ctx.addIssue({ code: 'custom', message, path });
		if (setup.images && new Set(setup.images).size !== setup.images.length) issue('Ảnh bị trùng', ['images']);
		if ((setup.options === undefined) !== (setup.variants === undefined)) {
			issue('Phân loại và tổ hợp phải gửi cùng nhau', [setup.options === undefined ? 'options' : 'variants']);
			return;
		}
		if (!setup.options) return;

		const names = setup.options.map((entry) => entry.name);
		if (new Set(names).size !== names.length) issue('Tên phân loại bị trùng', ['options']);
		setup.options.forEach((entry, index) => {
			if (new Set(entry.values).size !== entry.values.length) issue('Giá trị phân loại bị trùng', ['options', index, 'values']);
			if (entry.previousValues && entry.previousValues.length !== entry.values.length) issue('previousValues không khớp values', ['options', index, 'previousValues']);
		});
		const count = combinationCount(setup.options);
		if (count > MAX_VARIANT_COMBINATIONS) {
			issue(`Tối đa ${MAX_VARIANT_COMBINATIONS} tổ hợp (hiện có ${count})`, ['options']);
			return;
		}

		const expected = new Set(optionCombinations(setup.options).map(keyOf));
		const seen = new Set();
		setup.variants.forEach((entry, index) => {
			const key = keyOf(entry.optionValues);
			if (!expected.has(key)) issue('Tổ hợp không khớp các phân loại', ['variants', index, 'optionValues']);
			else if (seen.has(key)) issue('Tổ hợp bị trùng', ['variants', index, 'optionValues']);
			seen.add(key);
			if (entry.imageUrl && setup.images && !setup.images.includes(entry.imageUrl)) issue('Ảnh của tổ hợp phải là một ảnh của sản phẩm', ['variants', index, 'imageUrl']);
		});
		if (seen.size !== expected.size) issue('Thiếu tổ hợp phân loại', ['variants']);
		if (!setup.variants.some((entry) => entry.isActive !== false)) issue('Cần ít nhất một tổ hợp đang bán', ['variants']);
		const skus = setup.variants.map((entry) => entry.sku).filter(Boolean);
		if (new Set(skus).size !== skus.length) issue('SKU bị trùng', ['variants']);
	});
