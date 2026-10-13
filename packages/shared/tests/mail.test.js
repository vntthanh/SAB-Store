import { describe, it, expect } from 'vitest';
import { mailSettingsUpdate, mailTestRequest, toErrorList, isSensitiveField } from '../src/index.js';

const valid = () => ({
	enabled: true,
	host: 'smtp.example.com',
	port: 587,
	secure: false,
	username: 'mailer',
	pass: 'secret',
	fromName: 'SAB Store',
	fromAddress: 'shop@example.com',
	notifyOrderCreated: true,
	notifyStatusChanged: false,
});

const fieldsOf = (input) => {
	const result = mailSettingsUpdate.safeParse(input);
	return result.success ? [] : toErrorList(result.error.issues, input).map((e) => e.field);
};

describe('mailSettingsUpdate', () => {
	it('accepts a full body, with or without a password', () => {
		expect(mailSettingsUpdate.safeParse(valid()).success).toBe(true);
		const { pass, ...withoutPass } = valid();
		expect(mailSettingsUpdate.safeParse(withoutPass).success).toBe(true);
		expect(mailSettingsUpdate.safeParse({ ...valid(), pass: '' }).success).toBe(true);
	});

	it('does not rewrite the password: spaces are valid and kept', () => {
		const result = mailSettingsUpdate.safeParse({ ...valid(), pass: '  pa ss  ' });
		expect(result).toMatchObject({ success: true, data: { pass: '  pa ss  ' } });
	});

	it.each([
		['host', ''],
		['host', 'a'.repeat(254)],
		['host', 'smtp example.com'],
		['host', 'https://smtp.example.com'],
		['port', 0],
		['port', 65536],
		['port', 25.5],
		['port', '25x'],
		['port', null],
		['username', ''],
		['username', 'u'.repeat(255)],
		['pass', 'p'.repeat(257)],
		['pass', 123],
		['fromName', ''],
		['fromName', 'n'.repeat(101)],
		['fromName', 'Shop\r\nBcc: x@y.z'],
		['fromAddress', 'not-an-email'],
		['fromAddress', 'a@b.c\nBcc: x@y.z'],
		['enabled', 'true'],
		['secure', 1],
		['notifyOrderCreated', null],
		['notifyStatusChanged', undefined],
	])('rejects %s = %j', (field, value) => {
		expect(fieldsOf({ ...valid(), [field]: value })).toContain(field);
	});

	it('accepts the port bounds', () => {
		expect(mailSettingsUpdate.safeParse({ ...valid(), port: 1 }).success).toBe(true);
		expect(mailSettingsUpdate.safeParse({ ...valid(), port: 65535 }).success).toBe(true);
	});

	it('answers in Vietnamese', () => {
		const result = mailSettingsUpdate.safeParse({ ...valid(), port: 0, fromAddress: 'x' });
		const messages = result.error.issues.map((issue) => issue.message);
		expect(messages).toEqual(['Cổng SMTP phải là số nguyên từ 1 đến 65535', 'Địa chỉ email người gửi không hợp lệ']);
	});

	it('never echoes a rejected password back in an error list', () => {
		const input = { ...valid(), pass: 'p'.repeat(300) };
		const list = toErrorList(mailSettingsUpdate.safeParse(input).error.issues, input);
		expect(list.find((entry) => entry.field === 'pass')).not.toHaveProperty('value');
		expect(isSensitiveField('pass')).toBe(true);
	});
});

describe('mailTestRequest', () => {
	it('accepts an email, trimmed', () => {
		expect(mailTestRequest.safeParse({ to: ' admin@example.com ' })).toMatchObject({ success: true, data: { to: 'admin@example.com' } });
	});

	it.each([{}, { to: '' }, { to: 'nope' }, { to: 5 }, { to: ['a@b.co'] }])('rejects %j', (body) => {
		expect(mailTestRequest.safeParse(body).success).toBe(false);
	});
});
