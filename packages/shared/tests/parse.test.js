import { describe, it, expect } from 'vitest';
import { z, toErrorList, formatIssuePath, isSensitiveField, passwordChange, studentId } from '../src/index.js';

describe('formatIssuePath', () => {
	it.each([
		[[], ''],
		[['email'], 'email'],
		[['items', 0, 'quantity'], 'items[0].quantity'],
		[['items', 2], 'items[2]'],
		[[0, 'a'], '[0].a'],
		[['a', 'b', 'c'], 'a.b.c'],
	])('%j -> %j', (path, expected) => {
		expect(formatIssuePath(path)).toBe(expected);
	});
});

describe('isSensitiveField', () => {
	it.each(['password', 'newPassword', 'currentPassword', 'resetToken', 'client_secret', 'apiKey', 'creditCard'])(
		'%s is sensitive',
		(field) => expect(isSensitiveField(field)).toBe(true),
	);
	it.each(['email', 'items[0].quantity', 'studentId', ''])('%j is not sensitive', (field) =>
		expect(isSensitiveField(field)).toBe(false),
	);
});

describe('toErrorList', () => {
	const schema = z.object({
		email: z.string().email('Email không hợp lệ'),
		items: z.array(z.object({ quantity: z.number().int().min(1, 'Số lượng phải từ 1-100') })).min(1, 'Đơn hàng phải có ít nhất 1 sản phẩm'),
	});
	const errorsFor = (body) => toErrorList(schema.safeParse(body).error.issues, body);

	it('writes nested paths like express-validator and echoes the original value', () => {
		expect(errorsFor({ email: 'nope', items: [{ quantity: 0 }, { quantity: 5 }] })).toEqual([
			{ field: 'email', message: 'Email không hợp lệ', value: 'nope' },
			{ field: 'items[0].quantity', message: 'Số lượng phải từ 1-100', value: 0 },
		]);
	});

	it('takes the value from the unparsed body, not from a transform', () => {
		const body = { studentId: '  15123456 ' };
		const result = z.object({ studentId }).safeParse(body);
		expect(toErrorList(result.error.issues, body)).toEqual([
			expect.objectContaining({ field: 'studentId', value: '  15123456 ' }),
		]);
	});

	it('leaves value undefined for a missing field', () => {
		const [entry] = errorsFor({ items: [{ quantity: 1 }] });
		expect(entry.field).toBe('email');
		expect(entry.value).toBeUndefined();
	});

	it('never carries the value of a sensitive field', () => {
		const body = { currentPassword: '', newPassword: 'hunter2' };
		const list = toErrorList(passwordChange.safeParse(body).error.issues, body);
		expect(list.length).toBeGreaterThan(0);
		for (const entry of list) {
			expect(entry).not.toHaveProperty('value');
			expect(JSON.stringify(entry)).not.toContain('hunter2');
		}
	});

	it('keeps a root-level issue under an empty field', () => {
		const rooted = z.object({ a: z.string().optional(), b: z.string().optional() }).refine((v) => v.a || v.b, 'Cần ít nhất một trường');
		const body = {};
		expect(toErrorList(rooted.safeParse(body).error.issues, body)).toEqual([
			{ field: '', message: 'Cần ít nhất một trường' },
		]);
	});

	it('never echoes the body through a root-level issue', () => {
		const schema = passwordChange.refine((v) => v.currentPassword !== v.newPassword, 'Mật khẩu mới phải khác mật khẩu hiện tại');
		const body = { currentPassword: 'Same-Secret-1', newPassword: 'Same-Secret-1' };
		const list = toErrorList(schema.safeParse(body).error.issues, body);
		expect(list).toEqual([{ field: '', message: 'Mật khẩu mới phải khác mật khẩu hiện tại' }]);
		expect(JSON.stringify(list)).not.toContain('Same-Secret-1');
	});

	it('tolerates a body that is not an object', () => {
		const result = schema.safeParse('text');
		expect(toErrorList(result.error.issues, 'text')).toEqual([
			{ field: '', message: 'Kiểu dữ liệu không hợp lệ (cần đối tượng)' },
		]);
	});

	it('is deterministic: the same input always yields the same list', () => {
		const body = { email: 'x', items: [{ quantity: 0 }, { quantity: 0 }] };
		expect(JSON.stringify(errorsFor(body))).toBe(JSON.stringify(errorsFor(body)));
	});
});
