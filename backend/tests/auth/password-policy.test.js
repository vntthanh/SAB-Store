const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const { findUser, countRows } = require('../helpers/db');

// Passwords reach the server through the admin API (create / reset) and the
// self-service change; each is checked against the length minimum and the
// shared common-password blocklist.
describe('password policy', () => {
	let app;
	let admin;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		admin = await makeAdminSession(app);
	});

	const createUser = (email, password) => request(app)
		.post('/api/auth/admin/create-user')
		.set('Cookie', admin.cookies)
		.send({ email, password, name: 'Policy', role: 'seller', data: { username: email.split('@')[0].replace(/\W/g, '_') } });

	// 7 characters and not on the blocklist, so only the length rule can reject it.
	it('rejects a password shorter than the minimum and creates no user', async () => {
		const res = await createUser('short-password@example.com', 'abcdefg');

		expect(res.status).toBe(400);
		expect(res.body.message).toMatch(/ít nhất 8/);
		expect(await findUser({ email: 'short-password@example.com' })).toBeNull();
		expect(await countRows('user', {})).toBe(1); // the admin only
	});

	it('rejects the most common leaked password, "123456"', async () => {
		const res = await createUser('weak-password@example.com', '123456');

		expect(res.status).toBe(400);
		expect(await findUser({ email: 'weak-password@example.com' })).toBeNull();
	});

	it('accepts a password of exactly the minimum length', async () => {
		const res = await createUser('min-length@example.com', 'abcdefgh');
		expect(res.status).toBe(200);
	});

	it('rejects a short password on an admin password reset', async () => {
		const created = await createUser('short-reset@example.com', 'Str0ngPassw0rd!');
		const res = await request(app)
			.post('/api/auth/admin/set-user-password')
			.set('Cookie', admin.cookies)
			.send({ userId: created.body.user.id, newPassword: 'abcdefg' });
		expect(res.status).toBe(400);
	});

	it('rejects a common password even when it meets the length minimum', async () => {
		const res = await createUser('common-password@example.com', 'password1'); // 9 chars, in COMMON_PASSWORDS

		expect(res.status).toBe(400);
		expect(await findUser({ email: 'common-password@example.com' })).toBeNull();
	});

	it('rejects a common password on an admin password reset', async () => {
		const created = await createUser('reset-target@example.com', 'Str0ngPassw0rd!');
		expect(created.status).toBe(200);

		const res = await request(app)
			.post('/api/auth/admin/set-user-password')
			.set('Cookie', admin.cookies)
			.send({ userId: created.body.user.id, newPassword: 'password1' });

		expect(res.status).toBe(400);
		const signIn = await request(app).post('/api/auth/sign-in/email').send({ email: 'reset-target@example.com', password: 'Str0ngPassw0rd!' });
		expect(signIn.status).toBe(200);
	});

	it('accepts a strong, non-blocklisted password', async () => {
		const res = await createUser('strong-password@example.com', 'Str0ngPassw0rd!');

		expect(res.status).toBe(200);
		expect(await findUser({ email: 'strong-password@example.com' })).not.toBeNull();
	});
});
