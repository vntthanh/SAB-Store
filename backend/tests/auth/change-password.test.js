/**
 * Own-password change as the UI performs it: the admin screen and the seller
 * screen both post to /api/seller/change-password with their session cookie.
 */
const { randomUUID } = require('crypto');
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const User = require('../../models/User');

const CURRENT = 'factory-test-password-1';
const NEXT = 'Zq9xK2mW4vB';
const URL = '/api/seller/change-password';

describe('POST /api/seller/change-password', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	const signIn = (email, password) => request(app).post('/api/auth/sign-in/email').send({ email, password });

	async function makeSellerSession() {
		const id = randomUUID().slice(0, 8);
		const email = `seller-${id}@test.local`;
		const signUp = await request(app)
			.post('/api/auth/sign-up/email')
			.send({ email, password: CURRENT, name: 'Seller', username: `seller_${id}` });
		expect(signUp.status).toBe(200);
		await User.updateOne({ email }, { $set: { role: 'seller' } });
		const res = await signIn(email, CURRENT);
		expect(res.status).toBe(200);
		return { email, cookies: res.headers['set-cookie'] };
	}

	it('lets an admin change their own password', async () => {
		const admin = await makeAdminSession(app);

		const res = await request(app).post(URL).set('Cookie', admin.cookies)
			.send({ currentPassword: CURRENT, newPassword: NEXT });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ success: true });
		expect((await signIn(admin.email, NEXT)).status).toBe(200);
		expect((await signIn(admin.email, CURRENT)).status).not.toBe(200);
	});

	it('answers a wrong current password with a 400 the form can attach to the field', async () => {
		const admin = await makeAdminSession(app);

		const res = await request(app).post(URL).set('Cookie', admin.cookies)
			.send({ currentPassword: 'not-the-password-1', newPassword: NEXT });

		expect(res.status).toBe(400);
		expect(res.body).toEqual({
			success: false,
			message: 'Mật khẩu hiện tại không đúng',
			errors: [{ field: 'currentPassword', message: 'Mật khẩu hiện tại không đúng' }],
		});
		expect((await signIn(admin.email, CURRENT)).status).toBe(200);
	});

	it('keeps working for a seller, with the same wrong-password answer', async () => {
		const seller = await makeSellerSession();

		const wrong = await request(app).post(URL).set('Cookie', seller.cookies)
			.send({ currentPassword: 'not-the-password-1', newPassword: NEXT });
		expect(wrong.status).toBe(400);
		expect(wrong.body.errors).toEqual([{ field: 'currentPassword', message: 'Mật khẩu hiện tại không đúng' }]);

		const ok = await request(app).post(URL).set('Cookie', seller.cookies)
			.send({ currentPassword: CURRENT, newPassword: NEXT });
		expect(ok.status).toBe(200);
		expect((await signIn(seller.email, NEXT)).status).toBe(200);
	});

	it('rejects a request without a session', async () => {
		const res = await request(app).post(URL).send({ currentPassword: CURRENT, newPassword: NEXT });
		expect(res.status).toBe(401);
	});
});
