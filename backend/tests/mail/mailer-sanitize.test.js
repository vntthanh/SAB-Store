const { sanitizeMailError, takeTestSlot } = require('../../services/mailer');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

describe('sanitizeMailError', () => {
	const user = 'mailer-user';
	const pass = 'S3cret-smtp-pass';

	it('keeps the SMTP code, response code and the server text', () => {
		const text = sanitizeMailError({ code: 'EAUTH', responseCode: 535, response: '535 Authentication failed' }, user, pass);
		expect(text).toBe('EAUTH 535: 535 Authentication failed');
	});

	it('removes the username and password as typed, in any letter case', () => {
		const text = sanitizeMailError({ response: `denied for ${user} with ${pass.toUpperCase()}` }, user, pass);
		expect(text).not.toContain(user);
		expect(text.toLowerCase()).not.toContain(pass.toLowerCase());
		expect(text).toContain('[redacted]');
	});

	it('removes the base64 forms, AUTH PLAIN envelope included', () => {
		const response = [
			`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`,
			`user ${b64(user)}`,
			`pass ${b64(pass)}`
		].join(' | ');
		const text = sanitizeMailError({ response }, user, pass);
		for (const leaked of [b64(`\0${user}\0${pass}`), b64(user), b64(pass), user, pass]) {
			expect(text).not.toContain(leaked);
		}
	});

	it('caps the text at 200 characters after redacting', () => {
		const text = sanitizeMailError({ code: 'ECONNECTION', response: `${'x'.repeat(500)}${pass}` }, user, pass);
		expect(text.length).toBeLessThanOrEqual(200);
	});

	it('answers with a generic text for an error with no fields', () => {
		expect(sanitizeMailError(new Error(`boom ${pass}`), user, pass)).toBe('Gửi mail thất bại');
		expect(sanitizeMailError(undefined, user, pass)).toBe('Gửi mail thất bại');
	});
});

describe('takeTestSlot', () => {
	it('allows five sends in ten minutes per key and frees them as the window slides', () => {
		const start = 1_000_000;
		for (let i = 0; i < 5; i++) expect(takeTestSlot('limiter-a', start + i)).toBe(true);
		expect(takeTestSlot('limiter-a', start + 10)).toBe(false);
		expect(takeTestSlot('limiter-b', start + 10)).toBe(true);
		expect(takeTestSlot('limiter-a', start + 10 * 60 * 1000 + 1)).toBe(true);
	});
});
