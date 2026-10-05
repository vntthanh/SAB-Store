import { describe, expect, it } from 'vitest';
import {
	orderCreate,
	directOrder,
	orderUpdate,
	orderItemsEdit,
	orderNotes,
	orderIdParams,
	makeComboItems,
	wholeNumber,
	toErrorList,
} from '../src/index.js';

const OID = '507f1f77bcf86cd799439011';

const validOrder = () => ({
	studentId: '24120001',
	fullName: 'Nguyen Van A',
	email: 'a@example.com',
	phoneNumber: '0987654321',
	additionalNote: '',
	items: [{ productId: OID, quantity: 1 }],
	expectedTotal: 0,
});

const errorsOf = (schema, body) => {
	const result = schema.safeParse(body);
	return result.success ? null : toErrorList(result.error.issues, body);
};
const pairs = (errors) => errors.map((e) => [e.field, e.message]);

describe('orderCreate', () => {
	it('accepts a complete order', () => {
		expect(orderCreate.safeParse(validOrder()).success).toBe(true);
	});

	it('checks customer text after trimming it', () => {
		const padded = {
			...validOrder(),
			studentId: ' 24120001 ',
			fullName: '  Nguyễn Văn A  ',
			email: ' a@example.com ',
			phoneNumber: ' 0987654321 ',
		};
		expect(orderCreate.safeParse(padded).success).toBe(true);
		expect(pairs(errorsOf(orderCreate, { ...validOrder(), fullName: '   ' }))).toEqual([
			['fullName', 'Họ tên là bắt buộc'],
			['fullName', 'Họ tên phải từ 2-100 ký tự'],
			['fullName', 'Họ tên chỉ được chứa chữ cái và khoảng trắng'],
		]);
	});

	it('does not change the case of an email', () => {
		const body = { ...validOrder(), email: 'User.Name@Example.COM' };
		expect(orderCreate.safeParse(body).success).toBe(true);
		expect(body.email).toBe('User.Name@Example.COM');
	});

	it('reports a missing text field with its required and its format message', () => {
		const { phoneNumber, ...withoutPhone } = validOrder();
		expect(pairs(errorsOf(orderCreate, withoutPhone))).toEqual([
			['phoneNumber', 'Số điện thoại là bắt buộc'],
			['phoneNumber', 'Số điện thoại phải có 10 số và bắt đầu bằng 0'],
		]);
	});

	it('reports the failing line of the cart as items[N].field', () => {
		const items = [
			{ productId: OID, quantity: 1 },
			{ productId: OID, quantity: 1 },
			{ productId: 'nope', quantity: 0 },
		];
		expect(errorsOf(orderCreate, { ...validOrder(), items })).toEqual([
			{ field: 'items[2].productId', message: 'ID sản phẩm không hợp lệ', value: 'nope' },
			{ field: 'items[2].quantity', message: 'Số lượng phải từ 1-100', value: 0 },
		]);
	});

	it('treats a cart line that is not an object as having every field wrong', () => {
		expect(pairs(errorsOf(orderCreate, { ...validOrder(), items: [null] }))).toEqual([
			['items[0].productId', 'ID sản phẩm không hợp lệ'],
			['items[0].quantity', 'Số lượng phải từ 1-100'],
		]);
	});

	it('bounds a quantity at 100 and accepts digit strings only', () => {
		const withQuantity = (quantity) => ({ ...validOrder(), items: [{ productId: OID, quantity }] });
		expect(orderCreate.safeParse(withQuantity(100)).success).toBe(true);
		expect(orderCreate.safeParse(withQuantity('100')).success).toBe(true);
		expect(orderCreate.safeParse(withQuantity('002')).success).toBe(true);
		for (const bad of [101, 0, -1, 1.5, '+2', ' 2', '2.0', '1e2', '', null, true, [2], { $ne: null }, 1e21]) {
			expect(errorsOf(orderCreate, withQuantity(bad)), JSON.stringify(bad)).toEqual([
				expect.objectContaining({ field: 'items[0].quantity', message: 'Số lượng phải từ 1-100' }),
			]);
		}
	});

	it('requires the displayed total and distinguishes absent from invalid', () => {
		const { expectedTotal, ...withoutTotal } = validOrder();
		expect(pairs(errorsOf(orderCreate, withoutTotal))).toEqual([
			['expectedTotal', 'Thiếu tổng tiền hiển thị, vui lòng tải lại trang'],
		]);
		expect(pairs(errorsOf(orderCreate, { ...validOrder(), expectedTotal: null }))).toEqual([
			['expectedTotal', 'Thiếu tổng tiền hiển thị, vui lòng tải lại trang'],
		]);
		for (const bad of ['100', -1, 1.5, true, [], { $ne: null }, '']) {
			expect(pairs(errorsOf(orderCreate, { ...validOrder(), expectedTotal: bad })), JSON.stringify(bad)).toEqual([
				['expectedTotal', 'Tổng tiền hiển thị không hợp lệ'],
			]);
		}
		expect(orderCreate.safeParse({ ...validOrder(), expectedTotal: 300000 }).success).toBe(true);
	});

	it('refuses operator objects in every field without throwing', () => {
		for (const field of ['studentId', 'fullName', 'email', 'phoneNumber', 'additionalNote', 'items', 'expectedTotal']) {
			const result = orderCreate.safeParse({ ...validOrder(), [field]: { $ne: null } });
			expect(result.success, field).toBe(false);
			expect(result.error.issues.every((i) => i.path[0] === field)).toBe(true);
		}
	});

	it('reports a wrong-typed text field once, not once per rule', () => {
		const errors = errorsOf(orderCreate, { ...validOrder(), fullName: [] });
		expect(pairs(errors)).toEqual([['fullName', 'Họ tên phải từ 2-100 ký tự']]);
	});

	it('limits the note to 500 characters after trimming', () => {
		expect(orderCreate.safeParse({ ...validOrder(), additionalNote: ` ${'a'.repeat(500)} ` }).success).toBe(true);
		expect(pairs(errorsOf(orderCreate, { ...validOrder(), additionalNote: 'a'.repeat(501) }))).toEqual([
			['additionalNote', 'Ghi chú không được vượt quá 500 ký tự'],
		]);
		expect(orderCreate.safeParse({ ...validOrder(), additionalNote: null }).success).toBe(true);
	});

	it('echoes the client value, not a trimmed one', () => {
		const errors = errorsOf(orderCreate, { ...validOrder(), email: '  nope  ' });
		expect(errors).toEqual([{ field: 'email', message: 'Email không hợp lệ', value: '  nope  ' }]);
	});
});

describe('directOrder', () => {
	it('validates only the displayed total', () => {
		expect(directOrder.safeParse({ expectedTotal: 0 }).success).toBe(true);
		expect(directOrder.safeParse({ expectedTotal: 0, allowOverMax: true, items: 'ignored' }).success).toBe(true);
		expect(pairs(errorsOf(directOrder, {}))).toEqual([
			['expectedTotal', 'Thiếu tổng tiền hiển thị, vui lòng tải lại trang'],
		]);
	});
});

describe('orderUpdate', () => {
	it('accepts the four statuses and optional trimmed text', () => {
		for (const status of ['confirmed', 'paid', 'delivered', 'cancelled']) {
			expect(orderUpdate.safeParse({ status }).success).toBe(true);
		}
		expect(orderUpdate.safeParse({ status: 'paid', transactionCode: ` ${'x'.repeat(50)} `, note: null }).success).toBe(true);
	});

	it('refuses an unknown status and over-long text', () => {
		const errors = errorsOf(orderUpdate, {
			status: 'pending',
			transactionCode: 'x'.repeat(51),
			cancelReason: 'x'.repeat(501),
			note: 'x'.repeat(501),
		});
		expect(pairs(errors)).toEqual([
			['status', 'Trạng thái không hợp lệ'],
			['transactionCode', 'Mã giao dịch không được vượt quá 50 ký tự'],
			['cancelReason', 'Lý do hủy không được vượt quá 500 ký tự'],
			['note', 'Ghi chú không được vượt quá 500 ký tự'],
		]);
	});

	it('refuses a status sent as an array', () => {
		expect(pairs(errorsOf(orderUpdate, { status: ['paid'] }))).toEqual([['status', 'Trạng thái không hợp lệ']]);
	});
});

describe('orderIdParams', () => {
	it('accepts 24 hex characters in either case and refuses everything else', () => {
		expect(orderIdParams.safeParse({ id: OID }).success).toBe(true);
		expect(orderIdParams.safeParse({ id: OID.toUpperCase() }).success).toBe(true);
		for (const id of ['not-an-id', OID.slice(1), `${OID}a`, '', undefined, 12]) {
			expect(pairs(errorsOf(orderIdParams, { id })), String(id)).toEqual([['id', 'ID đơn hàng không hợp lệ']]);
		}
	});
});

describe('orderItemsEdit', () => {
	const valid = () => ({ items: [{ productId: OID, quantity: 1 }], expectedRevision: 0, reason: 'doi hang' });

	it('accepts digit strings for the numbers and trims the reason before measuring it', () => {
		expect(orderItemsEdit.safeParse(valid()).success).toBe(true);
		expect(orderItemsEdit.safeParse({
			items: [{ productId: OID, quantity: '3' }],
			expectedRevision: '7',
			reason: ` ${'a'.repeat(200)} `,
		}).success).toBe(true);
	});

	it('bounds the cart at 50 lines and the reason at 1 to 200 characters', () => {
		const lines = (n) => Array.from({ length: n }, () => ({ productId: OID, quantity: 1 }));
		expect(orderItemsEdit.safeParse({ ...valid(), items: lines(50) }).success).toBe(true);
		expect(pairs(errorsOf(orderItemsEdit, { ...valid(), items: lines(51) }))).toEqual([
			['items', 'Danh sách sản phẩm phải có từ 1 đến 50 dòng'],
		]);
		expect(pairs(errorsOf(orderItemsEdit, { ...valid(), reason: '   ' }))).toEqual([
			['reason', 'Lý do phải từ 1 đến 200 ký tự'],
		]);
		expect(pairs(errorsOf(orderItemsEdit, { ...valid(), reason: 'a'.repeat(201) }))).toEqual([
			['reason', 'Lý do phải từ 1 đến 200 ký tự'],
		]);
	});

	it('reports a negative or fractional revision with one message', () => {
		for (const expectedRevision of [-1, 1.5, '-3', 'x', null, true]) {
			expect(pairs(errorsOf(orderItemsEdit, { ...valid(), expectedRevision }))).toEqual([
				['expectedRevision', 'expectedRevision phải là số nguyên không âm'],
			]);
		}
	});
});

describe('orderNotes', () => {
	it('needs at least one note and reports that at the root with no echoed body', () => {
		expect(errorsOf(orderNotes, {})).toEqual([
			{ field: '', message: 'Cần ít nhất một trong additionalNote hoặc note' },
		]);
		expect(errorsOf(orderNotes, { other: 'secret' })).toEqual([
			{ field: '', message: 'Cần ít nhất một trong additionalNote hoặc note' },
		]);
	});

	it('lets the customer note be cleared but not the internal one', () => {
		expect(orderNotes.safeParse({ additionalNote: '' }).success).toBe(true);
		expect(pairs(errorsOf(orderNotes, { note: '   ' }))).toEqual([
			['note', 'Ghi chú nội bộ phải từ 1 đến 500 ký tự'],
		]);
	});

	it('refuses null instead of treating it as absent', () => {
		expect(pairs(errorsOf(orderNotes, { additionalNote: null }))).toEqual([
			['additionalNote', 'Ghi chú khách hàng không hợp lệ'],
		]);
	});
});

describe('makeComboItems', () => {
	it('takes the per-line ceiling from its caller', () => {
		const schema = makeComboItems({ maxUnits: 5 });
		const body = (quantity) => ({ items: [{ productId: OID, quantity }] });
		expect(schema.safeParse(body(5)).success).toBe(true);
		expect(pairs(errorsOf(schema, body(6)))).toEqual([['items[0].quantity', 'Số lượng phải từ 1-5']]);
	});

	it('bounds the cart at 100 lines and tolerates any channel', () => {
		const schema = makeComboItems({ maxUnits: 200 });
		const lines = (n) => Array.from({ length: n }, () => ({ productId: OID, quantity: 1 }));
		expect(schema.safeParse({ items: lines(100), channel: 'offline' }).success).toBe(true);
		expect(schema.safeParse({ items: lines(1), channel: { $ne: null } }).success).toBe(true);
		expect(pairs(errorsOf(schema, { items: lines(101) }))).toEqual([
			['items', 'Danh sách sản phẩm phải có từ 1 đến 100 mục'],
		]);
	});
});

describe('wholeNumber', () => {
	const schema = wholeNumber({ min: 1, max: 10, message: 'bad' });

	it('reports a single message however many bounds a value breaks', () => {
		expect(schema.safeParse(1e21).error.issues).toHaveLength(1);
		expect(schema.safeParse(-5).error.issues).toHaveLength(1);
	});

	it('converts only exact digit strings', () => {
		expect(schema.parse('7')).toBe(7);
		for (const bad of ['', ' 7', '7 ', '07.0', '+7', '-7', '0x7', [7], null, undefined, true]) {
			expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
		}
	});

	it('refuses an integer beyond the safe range even as a digit string', () => {
		const unbounded = wholeNumber({ min: 0, message: 'bad' });
		expect(unbounded.safeParse('9007199254740993').success).toBe(false);
		expect(unbounded.safeParse(9007199254740991).success).toBe(true);
	});
});
