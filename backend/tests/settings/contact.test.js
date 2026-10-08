const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const Settings = require('../../models/Settings');

const { SETTINGS_KEY, DEFAULT_CONTACT } = Settings;
const PAYMENT_FIELDS = { bankNameId: 'MB', bankAccountId: '0123456789', prefixMessage: 'SAB' };

describe('contact settings', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('serves the default contact for a document saved before the fields existed', async () => {
		await Settings.collection.insertOne({ key: SETTINGS_KEY, ...PAYMENT_FIELDS });

		const res = await request(app).get('/api/settings');

		expect(res.body.data).toMatchObject(DEFAULT_CONTACT);
	});

	it('reports the default contact to the admin for a document saved before the fields existed', async () => {
		const { cookies } = await makeAdminSession(app);
		await Settings.collection.insertOne({ key: SETTINGS_KEY, ...PAYMENT_FIELDS });

		const res = await request(app).get('/api/admin/settings').set('Cookie', cookies);

		expect(res.body.data).toMatchObject(DEFAULT_CONTACT);
	});

	it('lets an admin change the contact, which the public endpoint then serves', async () => {
		const { cookies } = await makeAdminSession(app);

		const put = await request(app)
			.put('/api/admin/settings')
			.set('Cookie', cookies)
			.send({ ...PAYMENT_FIELDS, contactEmail: ' shop@example.com ', contactFacebookUrl: 'https://facebook.com/shop' });

		expect(put.status).toBe(200);
		const get = await request(app).get('/api/settings');
		expect(get.body.data).toMatchObject({ contactEmail: 'shop@example.com', contactFacebookUrl: 'https://facebook.com/shop' });
	});

	it('keeps an empty value so the footer hides that line', async () => {
		const { cookies } = await makeAdminSession(app);

		await request(app)
			.put('/api/admin/settings')
			.set('Cookie', cookies)
			.send({ ...PAYMENT_FIELDS, contactEmail: '', contactFacebookUrl: '' })
			.expect(200);

		const get = await request(app).get('/api/settings');
		expect(get.body.data).toMatchObject({ contactEmail: '', contactFacebookUrl: '' });
	});

	it('keeps the stored contact when the fields are omitted', async () => {
		const { cookies } = await makeAdminSession(app);
		await Settings.create({ ...PAYMENT_FIELDS, contactEmail: 'kept@example.com' });

		const put = await request(app)
			.put('/api/admin/settings')
			.set('Cookie', cookies)
			.send(PAYMENT_FIELDS);

		expect(put.body.data.contactEmail).toBe('kept@example.com');
	});

	it.each([
		['an invalid email', { contactEmail: 'not-an-email' }],
		['a script URL', { contactFacebookUrl: 'javascript:alert(1)' }],
		['an over-long email', { contactEmail: `${'a'.repeat(260)}@example.com` }],
		['an over-long URL', { contactFacebookUrl: `https://example.com/${'a'.repeat(500)}` }],
		['an operator object as email', { contactEmail: { $ne: null } }],
		['an operator object as URL', { contactFacebookUrl: { $ne: null } }],
	])('rejects %s without saving', async (_label, body) => {
		const { cookies } = await makeAdminSession(app);

		const res = await request(app)
			.put('/api/admin/settings')
			.set('Cookie', cookies)
			.send({ ...PAYMENT_FIELDS, ...body });

		expect(res.status).toBe(400);
		expect(await Settings.countDocuments()).toBe(0);
	});
});
