import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	storefrontSlug,
	storefrontCreate,
	storefrontUpdate,
	storefrontReorder,
	storefrontIdList,
	accessRuleCreate,
	emailListCreate,
	emailListUpdate,
	emailListEntriesAdd,
	otpRequest,
	otpVerify,
	staffLogin,
} from '../src/index.js';

const slugs = JSON.parse(readFileSync(new URL('./fixtures/storefront-slugs.json', import.meta.url), 'utf8'));
const ID_A = '0195f3a0-7b2c-7d4e-8a1b-2c3d4e5f6a7b';
const ID_B = '507f1f77bcf86cd799439011';
const ok = (schema, value) => schema.safeParse(value).success;

describe('storefrontSlug', () => {
	it.each(slugs.accept)('accepts %j', (slug) => expect(ok(storefrontSlug, slug)).toBe(true));
	it.each(slugs.reject)('rejects %j', (slug) => expect(ok(storefrontSlug, slug)).toBe(false));
});

describe('storefrontCreate / storefrontUpdate', () => {
	const valid = { name: ' Cửa hàng ', slug: 'cua-hang', visibility: 'PRIVATE', isActive: true };

	it('accepts a full body, with or without description', () => {
		expect(ok(storefrontCreate, valid)).toBe(true);
		expect(ok(storefrontCreate, { ...valid, description: 'x'.repeat(500) })).toBe(true);
		expect(storefrontCreate.parse(valid).name).toBe('Cửa hàng');
	});

	it.each([
		['name', ''],
		['name', 'a'.repeat(81)],
		['slug', 'Bad Slug'],
		['visibility', 'HIDDEN'],
		['isActive', 'true'],
		['description', 'x'.repeat(501)],
	])('rejects %s = %j', (field, value) => {
		expect(ok(storefrontCreate, { ...valid, [field]: value })).toBe(false);
	});

	it('update is partial but not empty, and still validates what is sent', () => {
		expect(ok(storefrontUpdate, { isActive: false })).toBe(true);
		expect(ok(storefrontUpdate, {})).toBe(false);
		expect(ok(storefrontUpdate, { slug: '-x' })).toBe(false);
	});

	it('messages are Vietnamese', () => {
		const result = storefrontCreate.safeParse({ ...valid, slug: 'X' });
		expect(result.error.issues[0].message).toMatch(/Đường dẫn/);
	});
});

describe('storefrontReorder / storefrontIdList', () => {
	it('accepts unique UUID and legacy ids', () => {
		expect(ok(storefrontReorder, { ids: [ID_A, ID_B] })).toBe(true);
	});
	it('rejects empty, duplicate (any case), invalid and oversized lists', () => {
		expect(ok(storefrontReorder, { ids: [] })).toBe(false);
		expect(ok(storefrontReorder, { ids: [ID_A, ID_A.toUpperCase()] })).toBe(false);
		expect(ok(storefrontReorder, { ids: ['nope'] })).toBe(false);
		const many = Array.from({ length: 101 }, (_, i) => `0195f3a0-7b2c-7d4e-8a1b-${String(i).padStart(12, '0')}`);
		expect(ok(storefrontReorder, { ids: many })).toBe(false);
		expect(ok(storefrontIdList(200), many)).toBe(true);
	});
});

describe('accessRuleCreate', () => {
	it.each([
		{ type: 'EMAIL', value: 'a@x.vn' },
		{ type: 'EMAIL', value: '  A@X.vn ' },
		{ type: 'DOMAIN', value: 'school.edu.vn' },
		{ type: 'DOMAIN', value: 'School.EDU' },
		{ type: 'LIST', emailListId: ID_A },
	])('accepts %j', (rule) => expect(ok(accessRuleCreate, rule)).toBe(true));

	it.each([
		{ type: 'EMAIL', value: 'nope' },
		{ type: 'EMAIL' },
		{ type: 'DOMAIN', value: 'localhost' },
		{ type: 'DOMAIN', value: '@school.edu' },
		{ type: 'DOMAIN', value: 'a@school.edu' },
		{ type: 'DOMAIN', value: '-bad.edu' },
		{ type: 'DOMAIN', value: 'a..edu' },
		{ type: 'LIST', emailListId: 'x' },
		{ type: 'LIST', value: 'a@x.vn' },
		{ type: 'OTHER', value: 'a@x.vn' },
		{ value: 'a@x.vn' },
	])('rejects %j', (rule) => expect(ok(accessRuleCreate, rule)).toBe(false));
});

describe('email lists', () => {
	it('create / update', () => {
		expect(ok(emailListCreate, { name: 'K2026' })).toBe(true);
		expect(ok(emailListCreate, { name: '' })).toBe(false);
		expect(ok(emailListUpdate, { description: null })).toBe(true);
		expect(ok(emailListUpdate, {})).toBe(false);
	});
	it('entries add: 1..5000 valid emails', () => {
		const emails = (n) => Array.from({ length: n }, (_, i) => `u${i}@x.vn`);
		expect(ok(emailListEntriesAdd, { emails: emails(5000) })).toBe(true);
		expect(ok(emailListEntriesAdd, { emails: emails(5001) })).toBe(false);
		expect(ok(emailListEntriesAdd, { emails: [] })).toBe(false);
		expect(ok(emailListEntriesAdd, { emails: ['a@x.vn', 'bad'] })).toBe(false);
	});
});

describe('auth forms', () => {
	it('otp', () => {
		expect(ok(otpRequest, { email: 'a@x.vn' })).toBe(true);
		expect(ok(otpRequest, { email: 'a' })).toBe(false);
		expect(ok(otpVerify, { email: 'a@x.vn', otp: '012345' })).toBe(true);
		for (const otp of ['12345', '1234567', 'abcdef', '12 456', 123456]) {
			expect(ok(otpVerify, { email: 'a@x.vn', otp })).toBe(false);
		}
	});
	it('staff login keeps the password untouched and applies no strength rules', () => {
		const result = staffLogin.safeParse({ identifier: ' admin ', password: ' a ' });
		expect(result).toMatchObject({ success: true, data: { identifier: 'admin', password: ' a ' } });
		expect(ok(staffLogin, { identifier: '', password: 'x' })).toBe(false);
		expect(ok(staffLogin, { identifier: 'a'.repeat(255), password: 'x' })).toBe(false);
		expect(ok(staffLogin, { identifier: 'admin', password: '' })).toBe(false);
	});
});
