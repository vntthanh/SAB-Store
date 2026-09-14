const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { auth } = require('../../lib/auth');

/**
 * /api/admin/settings used to be authenticated twice per request: server.js
 * mounted the broad '/api/admin' router first, which runs authenticateAdmin
 * and, for an authenticated admin, falls through with no matching route;
 * the request then reached the '/api/admin/settings' mount and ran
 * authenticateAdmin a second time — two getSession() round-trips for one
 * request. Only reproducible with a real admin session: an unauthenticated or
 * wrong-role caller is rejected by the first authenticateAdmin call and never
 * reaches the second mount at all.
 */
describe('admin settings mount does not double-authenticate', () => {
	let app;
	let sessionCookie;

	beforeAll(async () => {
		app = buildTestApp();

		await auth.api.createUser({
			body: {
				email: 'settings-admin@example.com',
				name: 'Settings Admin',
				password: 'Str0ngPassw0rd!',
				role: 'admin',
				data: { username: 'settings_admin' },
			},
		});

		const signInRes = await request(app)
			.post('/api/auth/sign-in/email')
			.send({ email: 'settings-admin@example.com', password: 'Str0ngPassw0rd!' });

		const setCookie = signInRes.headers['set-cookie'];
		expect(setCookie).toBeDefined();
		sessionCookie = setCookie.map((c) => c.split(';')[0]).join('; ');
	});

	it('calls getSession exactly once for GET /api/admin/settings', async () => {
		const spy = jest.spyOn(auth.api, 'getSession');

		await request(app)
			.get('/api/admin/settings')
			.set('Cookie', sessionCookie);

		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});
});
