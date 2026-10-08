import { describe, it, expect } from 'vitest';
import { contactEmail, contactUrl, CONTACT_EMAIL_MAX_LENGTH, CONTACT_URL_MAX_LENGTH } from '../src/index.js';

describe('contactEmail', () => {
	it('accepts and trims an email', () => {
		expect(contactEmail.safeParse('  sab@fit.hcmus.edu.vn ')).toMatchObject({ success: true, data: 'sab@fit.hcmus.edu.vn' });
	});

	it('accepts an empty or blank value as "hidden"', () => {
		expect(contactEmail.safeParse('   ')).toMatchObject({ success: true, data: '' });
	});

	it.each(['sab', 'sab@', 'a b@c.vn', `${'a'.repeat(CONTACT_EMAIL_MAX_LENGTH)}@x.vn`, null, 42])('rejects %s', (value) => {
		expect(contactEmail.safeParse(value).success).toBe(false);
	});
});

describe('contactUrl', () => {
	it.each(['https://t.sab.edu.vn/', 'http://facebook.com/sab'])('accepts %s', (url) => {
		expect(contactUrl.safeParse(url)).toMatchObject({ success: true, data: url });
	});

	it('accepts an empty value as "hidden"', () => {
		expect(contactUrl.safeParse('')).toMatchObject({ success: true, data: '' });
	});

	// Rendered as an href, so a script or data scheme must never pass.
	it.each([
		'javascript:alert(1)',
		' JavaScript:alert(1)',
		'data:text/html,<script>alert(1)</script>',
		'mailto:sab@fit.hcmus.edu.vn',
		'facebook.com/sab',
		`https://x.vn/${'a'.repeat(CONTACT_URL_MAX_LENGTH)}`,
		{ $ne: null },
	])('rejects %s', (value) => {
		expect(contactUrl.safeParse(value).success).toBe(false);
	});
});
