import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/api', () => ({
	mailSettingsService: { get: vi.fn(), update: vi.fn(), sendTest: vi.fn() }
}));

import { buildPayload, isDirty, tlsMismatch, toForm, validateMailForm } from './MailSettingsSection';

const SAVED = {
	enabled: true,
	host: 'smtp.example.com',
	port: 465,
	secure: true,
	username: 'mailer',
	fromName: 'SAB',
	fromAddress: 'shop@example.com',
	notifyOrderCreated: true,
	notifyStatusChanged: false,
	hasPassword: true,
	updatedAt: '2026-10-13T00:00:00.000Z',
	updatedBy: 'admin'
};

describe('toForm', () => {
	it('starts never-configured mail switched off on port 587 with an empty password', () => {
		expect(toForm(null)).toMatchObject({ enabled: false, port: '587', secure: false, pass: '' });
	});

	it('never carries the stored password into the form', () => {
		const form = toForm({ ...SAVED, pass: 'leaked', passEncrypted: 'leaked' });
		expect(form.pass).toBe('');
		expect(JSON.stringify(form)).not.toContain('leaked');
		expect(form.port).toBe('465');
	});
});

describe('buildPayload', () => {
	it('omits pass when the password input was left blank', () => {
		const payload = buildPayload({ ...toForm(SAVED), pass: '' });
		expect('pass' in payload).toBe(false);
		expect(payload.port).toBe(465);
	});

	it('sends the typed password untrimmed', () => {
		expect(buildPayload({ ...toForm(SAVED), pass: ' s3cret ' }).pass).toBe(' s3cret ');
	});

	it('trims text fields and converts port to a number', () => {
		const payload = buildPayload({ ...toForm(null), host: ' smtp.x.com ', port: '587', fromAddress: ' a@b.co ' });
		expect(payload).toMatchObject({ host: 'smtp.x.com', port: 587, fromAddress: 'a@b.co' });
	});
});

describe('isDirty', () => {
	it('is false for untouched values and true once any field or the password changes', () => {
		expect(isDirty(toForm(SAVED), SAVED)).toBe(false);
		expect(isDirty({ ...toForm(SAVED), host: 'other' }, SAVED)).toBe(true);
		expect(isDirty({ ...toForm(SAVED), pass: 'x' }, SAVED)).toBe(true);
	});
});

describe('validateMailForm', () => {
	const filled = { ...toForm(SAVED), host: 'smtp.example.com', username: 'mailer' };

	it('requires a password on first setup but not once one is stored', () => {
		expect(validateMailForm({ ...filled, pass: '' }, false)).toEqual({ pass: 'Mật khẩu SMTP là bắt buộc khi cấu hình lần đầu' });
		expect(validateMailForm({ ...filled, pass: '' }, true)).toEqual({});
		expect(validateMailForm({ ...filled, pass: 'secret' }, false)).toEqual({});
	});

	it('reports an invalid port with the shared schema message', () => {
		for (const port of ['0', '70000', '25.5', '', 'abc']) {
			expect(validateMailForm({ ...filled, pass: 'x', port }, true).port).toBe('Cổng SMTP phải là số nguyên từ 1 đến 65535');
		}
	});

	it('reports a malformed sender address and an empty host per field', () => {
		const errors = validateMailForm({ ...filled, pass: 'x', fromAddress: 'not-an-email', host: '' }, true);
		expect(errors.fromAddress).toBe('Địa chỉ email người gửi không hợp lệ');
		expect(errors.host).toMatch(/^Máy chủ SMTP/);
		expect(Object.keys(errors).sort()).toEqual(['fromAddress', 'host']);
	});
});

describe('tlsMismatch', () => {
	it('flags implicit TLS on the STARTTLS port and plain on the TLS port', () => {
		expect(tlsMismatch({ port: '587', secure: true })).toMatch(/587/);
		expect(tlsMismatch({ port: '465', secure: false })).toMatch(/465/);
	});

	it('stays quiet for matching pairs and other ports', () => {
		expect(tlsMismatch({ port: '587', secure: false })).toBeNull();
		expect(tlsMismatch({ port: '465', secure: true })).toBeNull();
		expect(tlsMismatch({ port: '2525', secure: true })).toBeNull();
	});
});
