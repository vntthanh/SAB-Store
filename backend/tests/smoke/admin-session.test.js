const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeCombo } = require('../helpers/factories');

// Proves the harness can mint a real authenticated admin session end to end
// (account creation through the auth API -> sign-in -> reusable cookie);
// every suite that needs an authenticated request depends on this working.
describe('makeAdminSession', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	// Depends on tests/env.js pointing DATABASE_URL at the per-file test database.
	// Without that, anything reaching /api/auth/* fails on a refused connection.
	it('grants access to an admin-only route', async () => {
		const { cookies } = await makeAdminSession(app);
		await makeCombo();

		const res = await request(app)
			.get('/api/combos')
			.set('Cookie', cookies);

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
	});

	it('is rejected by the same route without a session', async () => {
		const res = await request(app).get('/api/combos');

		expect([401, 403]).toContain(res.status);
	});
});
