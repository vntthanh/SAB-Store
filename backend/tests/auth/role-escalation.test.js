const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeSellerSession, createAccount } = require('../helpers/factories');
const { findUser, countRows } = require('../helpers/db');

describe('role escalation guard', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	const signUp = (extra = {}) => request(app)
		.post('/api/auth/sign-up/email')
		.send({
			email: 'escalation-attempt@example.com',
			username: 'escalation_attempt',
			name: 'Escalation Attempt',
			password: 'Str0ngPassw0rd!',
			...extra,
		});

	// There is no public registration: accounts are created by an admin only.
	it('refuses public sign-up, with or without a role, and creates no user', async () => {
		for (const extra of [{}, { role: 'admin' }]) {
			const res = await signUp(extra);
			expect(res.status).toBe(400);
			expect(res.body.code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED');
		}
		expect(await countRows('user', {})).toBe(0);
	});

	// `role` is `input: false`: a self-service body naming it is rejected outright.
	it('refuses a signed-in user changing their own role through update-user', async () => {
		const seller = await makeSellerSession(app);

		const res = await request(app).post('/api/auth/update-user').set('Cookie', seller.cookies).send({ name: 'x', role: 'admin' });

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('FIELD_NOT_ALLOWED');
		const stored = await findUser({ email: seller.email });
		expect(stored.role).toBe('seller');
		expect(stored.name).not.toBe('x');
	});

	it('gives an account created without a role the default user role', async () => {
		const account = await createAccount();
		expect((await findUser({ email: account.email })).role).toBe('user');
	});

	it('does not let a seller session create an admin', async () => {
		const seller = await makeSellerSession(app);
		const res = await request(app).post('/api/auth/admin/create-user').set('Cookie', seller.cookies).send({
			email: 'seller-made-admin@example.com',
			password: 'Str0ngPassw0rd!',
			name: 'Nope',
			role: 'admin',
			data: { username: 'seller_made_admin' },
		});
		expect(res.status).toBe(403);
		expect(await findUser({ email: 'seller-made-admin@example.com' })).toBeNull();
	});

	it('lets an admin session create a user with an explicit role', async () => {
		const admin = await makeAdminSession(app);
		const res = await request(app).post('/api/auth/admin/create-user').set('Cookie', admin.cookies).send({
			email: 'admin-made-seller@example.com',
			password: 'Str0ngPassw0rd!',
			name: 'Made',
			role: 'seller',
			data: { username: 'admin_made_seller' },
		});
		expect(res.status).toBe(200);
		expect((await findUser({ email: 'admin-made-seller@example.com' })).role).toBe('seller');
	});
});
