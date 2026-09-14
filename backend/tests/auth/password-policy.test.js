const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const User = require('../../models/User');

describe('password policy on sign-up', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	// minPasswordLength was 6, so "123456" — the single most common leaked
	// password — satisfied it. Raised to 8: this alone rejects "123456".
	it('rejects a 6-character password', async () => {
		const res = await request(app)
			.post('/api/auth/sign-up/email')
			.send({
				email: 'weak-password@example.com',
				username: 'weak_password',
				name: 'Weak Password',
				password: '123456',
			});

		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(await User.findOne({ email: 'weak-password@example.com' })).toBeNull();
	});

	// Defence-in-depth: a common password that happens to be 8+ characters
	// (so it passes the length check) is still blocked by the hooks.before
	// blocklist check reusing utils/passwordValidator.js's COMMON_PASSWORDS.
	it('rejects a common password even when it meets the length minimum', async () => {
		const res = await request(app)
			.post('/api/auth/sign-up/email')
			.send({
				email: 'common-password@example.com',
				username: 'common_password',
				name: 'Common Password',
				password: 'password1', // 9 chars, and in COMMON_PASSWORDS
			});

		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(await User.findOne({ email: 'common-password@example.com' })).toBeNull();
	});

	it('accepts a strong, non-blocklisted password', async () => {
		const res = await request(app)
			.post('/api/auth/sign-up/email')
			.send({
				email: 'strong-password@example.com',
				username: 'strong_password',
				name: 'Strong Password',
				password: 'Str0ngPassw0rd!',
			});

		expect(res.status).toBeLessThan(300);
		expect(await User.findOne({ email: 'strong-password@example.com' })).not.toBeNull();
	});
});
