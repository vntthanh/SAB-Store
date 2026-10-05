import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import {
	orderCreate,
	orderItemsEdit,
	orderNotes,
	passwordChange,
	loginPassword,
	isPlainObject,
	toErrorList,
	z,
} from '@sab/shared';
import { rulesFromSchema, requiredFromSchema, leftoverIssues } from './schema-rules';
import { NOTES_RULES } from '../components/admin/order-notes-rules';

const ORDER_FIELDS = ['studentId', 'fullName', 'email', 'phoneNumber', 'additionalNote'];

const VALID_ORDER = {
	studentId: '24120001',
	fullName: 'Nguyen Van A',
	email: 'a@example.com',
	phoneNumber: '0987654321',
	additionalNote: '',
};

describe('rulesFromSchema', () => {
	const rules = rulesFromSchema(orderCreate, { fields: ORDER_FIELDS });

	it('gives the server message for a bad field and null for a good one', () => {
		const values = { ...VALID_ORDER, phoneNumber: '123', fullName: '1' };
		expect(rules.phoneNumber(values.phoneNumber, values)).toBe('Số điện thoại phải có 10 số và bắt đầu bằng 0');
		expect(rules.fullName(values.fullName, values)).toBe('Họ tên phải từ 2-100 ký tự');
		expect(rules.email(values.email, values)).toBeNull();
	});

	it('reports the required message first when a field is empty', () => {
		const values = { studentId: '', fullName: '', email: '', phoneNumber: '', additionalNote: '' };
		expect(rules.studentId('', values)).toBe('Mã số sinh viên là bắt buộc');
		expect(rules.fullName('', values)).toBe('Họ tên là bắt buộc');
		expect(rules.phoneNumber('', values)).toBe('Số điện thoại là bắt buộc');
	});

	it('trims before checking, like the server', () => {
		const values = { ...VALID_ORDER, phoneNumber: ' 0987654321 ', email: ' a@example.com ' };
		expect(rules.phoneNumber(values.phoneNumber, values)).toBeNull();
		expect(rules.email(values.email, values)).toBeNull();
		const blank = { ...VALID_ORDER, fullName: '   ' };
		expect(rules.fullName(blank.fullName, blank)).toBe('Họ tên là bắt buộc');
	});

	it('works without a values object and with a value newer than values', () => {
		expect(rules.phoneNumber('12', undefined)).toBe('Số điện thoại phải có 10 số và bắt đầu bằng 0');
		expect(rules.phoneNumber('0987654321', { ...VALID_ORDER, phoneNumber: '1' })).toBeNull();
	});

	it('runs the schema once per values object, however many fields ask', () => {
		const toPayload = vi.fn((values) => values);
		const counted = rulesFromSchema(orderCreate, { fields: ORDER_FIELDS, toPayload });
		const values = { ...VALID_ORDER, email: 'bad' };
		ORDER_FIELDS.forEach((name) => counted[name](values[name], values));
		expect(toPayload).toHaveBeenCalledTimes(1);
		counted.email(values.email, { ...values });
		expect(toPayload).toHaveBeenCalledTimes(2);
	});

	it('validates the payload built by toPayload, not the raw form state', () => {
		const fromForm = rulesFromSchema(orderItemsEdit, {
			fields: ['reason'],
			toPayload: ({ draftReason }) => ({ reason: draftReason }),
		});
		const values = { draftReason: '' };
		expect(fromForm.reason('', { ...values, reason: '' })).toBe('Lý do phải từ 1 đến 200 ký tự');
		expect(fromForm.reason('ok', { draftReason: 'ok', reason: 'ok' })).toBeNull();
	});

	it('merges UI-only rules and lets them win for the same field', () => {
		const merged = rulesFromSchema(passwordChange, {
			fields: ['currentPassword', 'newPassword'],
			uiRules: {
				confirmPassword: (value, values) => (value === values.newPassword ? null : 'Mật khẩu xác nhận không khớp'),
				currentPassword: (value) => (value === 'forbidden' ? 'ui says no' : null),
			},
		});
		expect(Object.keys(merged).sort()).toEqual(['confirmPassword', 'currentPassword', 'newPassword']);
		const values = { currentPassword: 'forbidden', newPassword: 'Abcdefgh1', confirmPassword: 'x' };
		expect(merged.confirmPassword('x', values)).toBe('Mật khẩu xác nhận không khớp');
		expect(merged.currentPassword('forbidden', values)).toBe('ui says no');
		expect(merged.newPassword(values.newPassword, values)).toBeNull();
	});

	it('does not trim passwords and returns the first failing rule', () => {
		const pw = rulesFromSchema(passwordChange, { fields: ['currentPassword', 'newPassword'] });
		const spaces = { currentPassword: 'x', newPassword: '        ' };
		expect(pw.newPassword(spaces.newPassword, spaces)).toBe('Mật khẩu phải chứa ít nhất 1 chữ cái thường');
		const empty = { currentPassword: '', newPassword: '' };
		expect(pw.currentPassword('', empty)).toBe('Mật khẩu hiện tại là bắt buộc');
		expect(pw.newPassword('', empty)).toBe('Mật khẩu là bắt buộc');
		const short = { currentPassword: 'x', newPassword: 'Abc1' };
		expect(pw.newPassword('Abc1', short)).toBe('Mật khẩu phải có từ 8-128 ký tự');
	});

	it('login password only has to be present', () => {
		const schema = z.object({ password: loginPassword });
		const login = rulesFromSchema(schema, { fields: ['password'] });
		expect(login.password('', { password: '' })).toBe('Mật khẩu là bắt buộc');
		expect(login.password('a', { password: 'a' })).toBeNull();
	});

	it('attaches an object-level issue to the field its path names', () => {
		const schema = z.object({ a: z.string(), b: z.string() }).refine((v) => v.a === v.b, {
			message: 'must match',
			path: ['b'],
		});
		const r = rulesFromSchema(schema, { fields: ['a', 'b'] });
		expect(r.b('y', { a: 'x', b: 'y' })).toBe('must match');
		expect(r.a('x', { a: 'x', b: 'y' })).toBeNull();
	});

	it('attaches an array-path issue to the field of the same key the server uses', () => {
		const KEY = 'items[0].quantity';
		const r = rulesFromSchema(orderCreate, {
			fields: [KEY],
			toPayload: ({ quantity }) => ({
				...VALID_ORDER,
				items: [{ productId: '507f1f77bcf86cd799439011', quantity }],
				expectedTotal: 0,
			}),
		});
		expect(r[KEY](undefined, { quantity: 0 })).toBe('Số lượng phải từ 1-100');
		expect(r[KEY](undefined, { quantity: 2 })).toBeNull();
	});
});

describe('requiredFromSchema', () => {
	it('marks exactly the fields the order form shows as required, plus the keys the form does not render', () => {
		expect(requiredFromSchema(orderCreate)).toEqual({
			studentId: true,
			fullName: true,
			email: true,
			phoneNumber: true,
			items: true,
			expectedTotal: true,
		});
	});

	it('marks both password-change fields', () => {
		expect(requiredFromSchema(passwordChange)).toEqual({ currentPassword: true, newPassword: true });
	});

	it('marks the login password', () => {
		expect(requiredFromSchema(z.object({ password: loginPassword }))).toEqual({ password: true });
	});

	it('marks the reason, items and revision of an items edit', () => {
		expect(requiredFromSchema(orderItemsEdit)).toEqual({ items: true, expectedRevision: true, reason: true });
	});

	it('does not mark either note as required on its own', () => {
		expect(requiredFromSchema(orderNotes)).toEqual({});
	});
});

describe('leftoverIssues', () => {
	it('returns issues that belong to no form field, including the root', () => {
		expect(leftoverIssues(orderNotes, {}, ['additionalNote', 'note'])).toEqual([
			{ field: '', message: 'Cần ít nhất một trong additionalNote hoặc note' },
		]);
		expect(leftoverIssues(orderNotes, { note: 'hi' }, ['additionalNote', 'note'])).toEqual([]);
	});

	it('leaves out issues of the declared fields', () => {
		const payload = { items: [], expectedRevision: 0, reason: '' };
		const issues = leftoverIssues(orderItemsEdit, payload, ['reason']);
		expect(issues.map((i) => i.field)).toEqual(['items']);
	});
});

// The forms use the shared schemas through the adapter, so for every fixture payload a form field
// must show the first message the server reports for that field and nothing when it reports none.
// "First" is the order of the list the middleware sends (toErrorList over the same schema):
// the fixture stores `intentional` lists sorted, so its order cannot say which message is first.
// The fixture pins the content: the shown message must be one the server reported for the field.
// Skipped on purpose: `rawBody` cases (not JSON objects, the body parser answers them before any
// schema) and /combos/pricing (no client form; its unit cap lives in the backend).
describe('adapter agrees with the server (golden fixture)', () => {
	const fixture = JSON.parse(
		fs.readFileSync(new URL('../../../packages/shared/tests/fixtures/validation-golden.json', import.meta.url), 'utf8'),
	);
	const isString = (v) => typeof v === 'string';
	// A text input can only hold a string, and the notes form never sends a blank internal note.
	const NO_SAVED_NOTE = '\u0000not-a-real-note';

	// `valuesOf` turns a fixture body into the values the form would hold for it (null: the form
	// cannot hold that body, so the case does not apply).
	const FORMS = {
		'POST /api/orders': {
			rules: rulesFromSchema(orderCreate, { fields: ORDER_FIELDS }),
			fields: ORDER_FIELDS,
			valuesOf: (body) => body,
			schema: orderCreate,
			min: 200,
		},
		'POST /api/seller/change-password': {
			rules: rulesFromSchema(passwordChange, { fields: ['currentPassword', 'newPassword'] }),
			fields: ['currentPassword', 'newPassword'],
			valuesOf: (body) => body,
			schema: passwordChange,
			min: 45,
		},
		'PUT /api/admin/orders/:id/items': {
			rules: rulesFromSchema(orderItemsEdit, { fields: ['reason'] }),
			fields: ['reason'],
			valuesOf: (body) => body,
			schema: orderItemsEdit,
			min: 100,
		},
		'PATCH /api/admin/orders/:id/notes': {
			rules: NOTES_RULES,
			fields: ['additionalNote', 'note'],
			valuesOf: (body) => {
				const { additionalNote, note } = body;
				if (![additionalNote, note].every((v) => v === undefined || isString(v))) return null;
				if (note !== undefined && note.trim() === '') return null;
				return { additionalNote: additionalNote ?? NO_SAVED_NOTE, savedNote: NO_SAVED_NOTE, note: note ?? '' };
			},
			schema: orderNotes,
			min: 30,
		},
	};

	Object.entries(FORMS).forEach(([route, form]) => {
		const cases = fixture.filter(
			(c) => c.route === route && c.rawBody === undefined && isPlainObject(c.body) && form.valuesOf(c.body) !== null,
		);

		describe(route, () => {
			it(`has at least ${form.min} fixture cases`, () => {
				expect(cases.length).toBeGreaterThanOrEqual(form.min);
			});

			it('every field shows the first server message, or none when the server reported none', () => {
				cases.forEach((c) => {
					const source = c.intentional || c;
					const reported = source.expectErrors || [];
					const parsed = form.schema.safeParse(c.body);
					const serverList = parsed.success ? [] : toErrorList(parsed.error.issues, c.body);
					const values = form.valuesOf(c.body);
					form.fields.forEach((field) => {
						const first = serverList.find((e) => e.field === field);
						const actual = form.rules[field](values[field], values);
						expect({ case: c.name, field, message: actual }).toEqual({
							case: c.name,
							field,
							message: first ? first.message : null,
						});
						const fixtureMessages = reported.filter((e) => e.field === field).map((e) => e.message);
						if (actual === null) expect(fixtureMessages).toEqual([]);
						else expect(fixtureMessages).toContain(actual);
					});
				});
			});
		});
	});
});
