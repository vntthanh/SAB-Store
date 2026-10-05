import { describe, it, expect } from 'vitest';
import { z } from '../src/index.js';
import { customError } from '../src/z.js';

const messages = (schema, input) => {
	const result = schema.safeParse(input);
	expect(result.success).toBe(false);
	return result.error.issues.map((issue) => issue.message);
};

// Vietnamese diacritics never occur in Zod's English defaults, so one of them
// in the message proves the global map (not the English locale) produced it.
const VIETNAMESE = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i;

describe('global Vietnamese error map', () => {
	// Issues raised by real schemas; the first column is the code the schema is
	// expected to raise, so a Zod upgrade that renames a code fails here. Codes
	// no schema raises (invalid_element) are covered by the direct-call cases below.
	const cases = [
		['invalid_type', z.string(), 5, 'Kiểu dữ liệu không hợp lệ (cần chuỗi)'],
		['invalid_type', z.string(), undefined, 'Thiếu dữ liệu bắt buộc'],
		['invalid_type', z.string(), null, 'Thiếu dữ liệu bắt buộc'],
		['invalid_type', z.number(), '5', 'Kiểu dữ liệu không hợp lệ (cần số)'],
		['invalid_type', z.array(z.string()), 'x', 'Kiểu dữ liệu không hợp lệ (cần danh sách)'],
		['invalid_type', z.object({}), 'x', 'Kiểu dữ liệu không hợp lệ (cần đối tượng)'],
		['too_small', z.string().min(3), 'ab', 'Phải có ít nhất 3 ký tự'],
		['too_small', z.string().length(3), 'ab', 'Phải có đúng 3 ký tự'],
		['too_small', z.array(z.string()).min(2), ['a'], 'Phải có ít nhất 2 phần tử'],
		['too_small', z.number().min(5), 1, 'Giá trị phải lớn hơn hoặc bằng 5'],
		['too_small', z.number().gt(5), 5, 'Giá trị phải lớn hơn 5'],
		['too_small', z.date().min(new Date('2030-01-01')), new Date('2000-01-01'), 'Ngày quá sớm'],
		['too_big', z.string().max(3), 'abcd', 'Không được vượt quá 3 ký tự'],
		['too_big', z.string().length(3), 'abcd', 'Phải có đúng 3 ký tự'],
		['too_big', z.array(z.string()).max(1), ['a', 'b'], 'Không được vượt quá 1 phần tử'],
		['too_big', z.number().max(5), 9, 'Giá trị phải nhỏ hơn hoặc bằng 5'],
		['too_big', z.number().lt(5), 5, 'Giá trị phải nhỏ hơn 5'],
		['too_big', z.date().max(new Date('2000-01-01')), new Date('2030-01-01'), 'Ngày quá muộn'],
		['invalid_format', z.email(), 'nope', 'Email không hợp lệ'],
		['invalid_format', z.string().regex(/^\d+$/), 'abc', 'Định dạng không hợp lệ'],
		['invalid_format', z.url(), 'nope', 'Định dạng không hợp lệ'],
		['invalid_format', z.string().startsWith('a'), 'b', 'Định dạng không hợp lệ'],
		['invalid_value', z.enum(['a', 'b']), 'c', 'Giá trị không hợp lệ'],
		['invalid_value', z.literal('a'), 'b', 'Giá trị không hợp lệ'],
		['not_multiple_of', z.number().multipleOf(3), 4, 'Giá trị phải là bội số của 3'],
		['unrecognized_keys', z.object({ a: z.string() }).strict(), { a: 'x', b: 1, c: 2 }, 'Có trường không được hỗ trợ: b, c'],
		['invalid_union', z.union([z.string(), z.number()]), true, 'Giá trị không hợp lệ'],
		['invalid_key', z.record(z.string().min(3), z.string()), { ab: 'x' }, 'Khóa không hợp lệ'],
		['custom', z.string().refine(() => false), 'x', 'Dữ liệu không hợp lệ'],
	];

	it.each(cases)('%s -> Vietnamese message (%#)', (code, schema, input, expected) => {
		const result = schema.safeParse(input);
		expect(result.success).toBe(false);
		const issue = result.error.issues[0];
		expect(issue.code).toBe(code);
		expect(issue.message).toBe(expected);
	});

	it('maps invalid_element by calling the map directly (Zod v4 schemas report invalid_type or too_small for map and set members)', () => {
		const issue = { code: 'invalid_element', origin: 'map', key: 'k', issues: [], input: new Map() };
		expect(customError(issue)).toBe('Phần tử không hợp lệ');
	});

	it('never returns a falsy value, which would fall through to the English locale', () => {
		for (const code of ['invalid_type', 'too_small', 'too_big', 'invalid_format', 'not_multiple_of', 'unrecognized_keys', 'invalid_union', 'invalid_key', 'invalid_element', 'invalid_value', 'custom', 'brand_new_code']) {
			const message = customError({ code, expected: 'string', origin: 'string', minimum: 1, maximum: 1, divisor: 1, keys: ['k'], format: 'regex', input: 'x' });
			expect(typeof message).toBe('string');
			expect(message).toMatch(VIETNAMESE);
		}
	});

	it('lets a message set on the schema win over the global map', () => {
		expect(messages(z.string().min(3, 'Quá ngắn'), 'ab')).toEqual(['Quá ngắn']);
		expect(messages(z.string({ error: 'Cần chuỗi' }), 5)).toEqual(['Cần chuỗi']);
	});

	it('uses the Vietnamese map for nested fields too', () => {
		const schema = z.object({ items: z.array(z.object({ quantity: z.number().min(1) })) });
		expect(messages(schema, { items: [{ quantity: 0 }] })).toEqual(['Giá trị phải lớn hơn hoặc bằng 1']);
	});
});
