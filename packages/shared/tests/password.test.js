import { describe, it, expect } from 'vitest';
import {
	loginPassword,
	sellerPassword,
	newPassword,
	passwordChange,
	COMMON_PASSWORDS,
	PASSWORD_STRENGTH,
	calculatePasswordStrength,
	hasSequentialChars,
	hasRepeatedChars,
	isCommonPassword,
} from '../src/index.js';

const REQUIRED = 'Mật khẩu là bắt buộc';
const RANGE = 'Mật khẩu phải có từ 8-128 ký tự';
const LOWER = 'Mật khẩu phải chứa ít nhất 1 chữ cái thường';
const UPPER = 'Mật khẩu phải chứa ít nhất 1 chữ cái hoa';
const COMMON = 'Mật khẩu này quá phổ biến và không an toàn';

const errors = (schema, value) => {
	const result = schema.safeParse(value);
	return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('newPassword (full strength policy)', () => {
	it.each([
		['Abcdefg1', 'minimum length'],
		['Zq9!xK2#mW4$', 'mixed'],
		['A' + 'a'.repeat(127), 'maximum length'],
	])('accepts %s (%s)', (value) => {
		expect(errors(newPassword, value)).toEqual([]);
	});

	it.each([
		['1234568', [RANGE, LOWER, UPPER]],
		['1234567', [RANGE, LOWER, UPPER, COMMON]],
		['Abcdef1', [RANGE]],
		['A' + 'a'.repeat(128), [RANGE]],
		['abcdefgh', [UPPER]],
		['ABCDEFGH', [LOWER]],
		['12345678', [LOWER, UPPER, COMMON]],
		['Password1', [COMMON]],
		['PASSWORD1', [LOWER, COMMON]],
		['Passw0rd', [COMMON]],
		['', [REQUIRED, RANGE, LOWER, UPPER]],
	])('rejects %j with %j', (value, expected) => {
		expect(errors(newPassword, value)).toEqual(expected);
	});

	it('reports a non-string as required, once', () => {
		for (const value of [undefined, null, 12345678]) {
			expect(errors(newPassword, value)).toEqual([REQUIRED]);
		}
	});

	it('does not trim: surrounding spaces count as characters of the credential', () => {
		expect(errors(newPassword, ' Abcdef1 ')).toEqual([]);
		expect(errors(newPassword, '   Aa1   ')).toEqual([]);
		expect(errors(newPassword, ' '.repeat(8))).toEqual([LOWER, UPPER]);
	});
});

describe('sellerPassword (Better Auth bounds + blocklist)', () => {
	it('accepts a weak but long enough password', () => {
		expect(errors(sellerPassword, 'abcdefgh')).toEqual([]);
		expect(errors(sellerPassword, '12345679')).toEqual([]);
	});

	it.each([
		['1234568', ['Mật khẩu phải có ít nhất 8 ký tự']],
		['1234567', ['Mật khẩu phải có ít nhất 8 ký tự', COMMON]],
		['a'.repeat(129), ['Mật khẩu không được vượt quá 128 ký tự']],
		['password', [COMMON]],
		['Password1', [COMMON]],
		['', [REQUIRED, 'Mật khẩu phải có ít nhất 8 ký tự']],
	])('rejects %j with %j', (value, expected) => {
		expect(errors(sellerPassword, value)).toEqual(expected);
	});

	it('keeps the value exactly as sent', () => {
		expect(sellerPassword.parse('  spaced pass  ')).toBe('  spaced pass  ');
	});
});

describe('loginPassword (no strength rules)', () => {
	it('lets an existing weak password log in', () => {
		for (const value of ['a', '123', ' ', 'password']) expect(errors(loginPassword, value)).toEqual([]);
	});

	it('blocks only empty and non-string values', () => {
		expect(errors(loginPassword, '')).toEqual([REQUIRED]);
		expect(errors(loginPassword, undefined)).toEqual([REQUIRED]);
		expect(errors(loginPassword, 5)).toEqual([REQUIRED]);
	});
});

describe('passwordChange', () => {
	it('requires the current password but applies no strength rule to it', () => {
		const result = passwordChange.safeParse({ currentPassword: 'x', newPassword: 'Abcdefg1' });
		expect(result.success).toBe(true);
	});

	it('reports each field under its own path, in field order', () => {
		const result = passwordChange.safeParse({ currentPassword: '', newPassword: '1234568' });
		expect(result.error.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
			['currentPassword', 'Mật khẩu hiện tại là bắt buộc'],
			['newPassword', RANGE],
			['newPassword', LOWER],
			['newPassword', UPPER],
		]);
	});

	it('reports missing fields', () => {
		const result = passwordChange.safeParse({});
		expect(result.error.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
			['currentPassword', 'Mật khẩu hiện tại là bắt buộc'],
			['newPassword', REQUIRED],
			['newPassword', RANGE],
			['newPassword', LOWER],
			['newPassword', UPPER],
		]);
	});
});

describe('password rules', () => {
	it('matches the blocklist case-insensitively', () => {
		expect(isCommonPassword('PassWord')).toBe(true);
		expect(isCommonPassword('Zq9!xK2#mW4$')).toBe(false);
		expect(COMMON_PASSWORDS).toContain('123456');
	});

	it('detects runs and repeats', () => {
		expect(hasSequentialChars('xxABCxx')).toBe(true);
		expect(hasSequentialChars('Zq9!xK2#')).toBe(false);
		expect(hasRepeatedChars('aaab')).toBe(true);
		expect(hasRepeatedChars('aabb')).toBe(false);
	});

	it.each([
		['123456', PASSWORD_STRENGTH.WEAK],
		['abcdefgh', PASSWORD_STRENGTH.WEAK],
		['Abcdefg1', PASSWORD_STRENGTH.MEDIUM],
		['Zq9xK2mW4', PASSWORD_STRENGTH.MEDIUM],
		['Zq9!xK2#mW4$', PASSWORD_STRENGTH.STRONG],
	])('rates %s as %s', (value, strength) => {
		expect(calculatePasswordStrength(value)).toBe(strength);
	});
});
