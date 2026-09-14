const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const User = require('../../models/User');

describe('role escalation guard', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	// lib/auth.js marks the `role` additionalField `input: false`. Without that,
	// role joins the public /sign-up/email body schema and any anonymous
	// visitor can register straight into the admin role.
	it('ignores a client-supplied role:"admin" on public sign-up', async () => {
		const res = await request(app)
			.post('/api/auth/sign-up/email')
			.send({
				email: 'escalation-attempt@example.com',
				username: 'escalation_attempt',
				name: 'Escalation Attempt',
				password: 'Str0ngPassw0rd!',
				role: 'admin',
			});

		expect(res.status).toBeLessThan(300);

		const stored = await User.findOne({ email: 'escalation-attempt@example.com' });
		expect(stored).not.toBeNull();
		expect(stored.role).toBe('user');
	});
});
