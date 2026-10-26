const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, createAccount, signInSession } = require('../helpers/factories');
const { insertRawSettings } = require('../helpers/db');

const PAYMENT_FIELDS = { bankNameId: 'MB', bankAccountId: '0123456789', prefixMessage: 'SAB' };
const CLIENT_ID = '1234-abc.apps.googleusercontent.com';

describe('Google client id setting', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	const save = (cookies, googleClientId) => request(app)
		.put('/api/admin/settings')
		.set('Cookie', cookies)
		.send({ ...PAYMENT_FIELDS, googleClientId });

	it('is off (null on the public endpoint) for a row saved before the field existed', async () => {
		await insertRawSettings(PAYMENT_FIELDS);

		const res = await request(app).get('/api/settings');

		expect(res.body.data.googleClientId).toBeNull();
	});

	it('lets an admin save it trimmed, which the public endpoint then serves', async () => {
		const { cookies } = await makeAdminSession(app);

		const put = await save(cookies, `  ${CLIENT_ID} `);

		expect(put.status).toBe(200);
		expect(put.body.data.googleClientId).toBe(CLIENT_ID);
		const get = await request(app).get('/api/settings');
		expect(get.body.data.googleClientId).toBe(CLIENT_ID);
	});

	it('turns Google off again with an empty value', async () => {
		const { cookies } = await makeAdminSession(app);
		await save(cookies, CLIENT_ID).expect(200);

		await save(cookies, '').expect(200);

		const get = await request(app).get('/api/settings');
		expect(get.body.data.googleClientId).toBeNull();
	});

	it.each(['GOCSPX-a-client-secret', 'x.apps.googleusercontent.com.evil.example', { $ne: null }])(
		'refuses %s without touching the stored value',
		async (value) => {
			const { cookies } = await makeAdminSession(app);
			await save(cookies, CLIENT_ID).expect(200);

			const put = await save(cookies, value);

			expect(put.status).toBe(400);
			const get = await request(app).get('/api/settings');
			expect(get.body.data.googleClientId).toBe(CLIENT_ID);
		}
	);

	it('is not editable without an admin session', async () => {
		const res = await request(app).put('/api/admin/settings').send({ ...PAYMENT_FIELDS, googleClientId: CLIENT_ID });

		expect(res.status).toBe(401);
	});

	it('is not editable by a seller', async () => {
		const { cookies: adminCookies } = await makeAdminSession(app);
		await save(adminCookies, CLIENT_ID).expect(200);
		const seller = await createAccount({ role: 'seller', prefix: 'gcid' });
		const sellerCookies = await signInSession(app, seller);

		const put = await save(sellerCookies, 'other-1.apps.googleusercontent.com');

		expect(put.status).toBe(403);
		const get = await request(app).get('/api/settings');
		expect(get.body.data.googleClientId).toBe(CLIENT_ID);
	});
});
