const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const Settings = require('../../models/Settings');

const { SETTINGS_KEY, DEFAULT_NOTICES, NOTICE_MAX_LENGTH } = Settings;
const PAYMENT_FIELDS = { bankNameId: 'MB', bankAccountId: '0123456789', prefixMessage: 'SAB' };

describe('customer notice settings', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('serves the default notices for a document saved before the fields existed', async () => {
		await Settings.collection.insertOne({ key: SETTINGS_KEY, ...PAYMENT_FIELDS });

		const res = await request(app).get('/api/settings');

		expect(res.body.data).toMatchObject(DEFAULT_NOTICES);
	});

	// The admin form reads every notice as a string, so this path must fill defaults too.
	it('reports the default notices to the admin for a document saved before the fields existed', async () => {
		const { cookies } = await makeAdminSession(app);
		await Settings.collection.insertOne({ key: SETTINGS_KEY, ...PAYMENT_FIELDS });

		const res = await request(app).get('/api/admin/settings').set('Cookie', cookies);

		expect(res.status).toBe(200);
		expect(res.body.data).toMatchObject(DEFAULT_NOTICES);
	});

	it('stores the default notices on a first save that omits them', async () => {
		const { cookies } = await makeAdminSession(app);

		const put = await request(app)
			.put('/api/admin/settings')
			.set('Cookie', cookies)
			.send(PAYMENT_FIELDS);

		expect(put.status).toBe(200);
		expect(put.body.data).toMatchObject(DEFAULT_NOTICES);
	});

	it('accepts a notice of exactly the maximum length', async () => {
		const { cookies } = await makeAdminSession(app);

		const put = await request(app)
			.put('/api/admin/settings')
			.set('Cookie', cookies)
			.send({ ...PAYMENT_FIELDS, paymentNotice: 'x'.repeat(NOTICE_MAX_LENGTH) });

		expect(put.status).toBe(200);
	});

	it('lets an admin edit a notice as Markdown, which the public endpoint then serves', async () => {
		const { cookies } = await makeAdminSession(app);
		const markdown = '- Mục **một**\n- Mục hai';

		const put = await request(app)
			.put('/api/admin/settings')
			.set('Cookie', cookies)
			.send({ ...PAYMENT_FIELDS, checkoutNotice: `  ${markdown}\n\n` });

		expect(put.status).toBe(200);
		expect(put.body.data.checkoutNotice).toBe(markdown);

		const get = await request(app).get('/api/settings');
		expect(get.body.data.checkoutNotice).toBe(markdown);
		expect(get.body.data.paymentNotice).toBe(DEFAULT_NOTICES.paymentNotice);
	});

	it('keeps an emptied notice empty instead of restoring the default', async () => {
		const { cookies } = await makeAdminSession(app);

		await request(app)
			.put('/api/admin/settings')
			.set('Cookie', cookies)
			.send({ ...PAYMENT_FIELDS, eventNotice: '   ' })
			.expect(200);

		const get = await request(app).get('/api/settings');
		expect(get.body.data.eventNotice).toBe('');
	});

	it('keeps the current notice when the field is omitted', async () => {
		const { cookies } = await makeAdminSession(app);
		await Settings.create({ ...PAYMENT_FIELDS, paymentNotice: 'Kept' });

		const put = await request(app)
			.put('/api/admin/settings')
			.set('Cookie', cookies)
			.send(PAYMENT_FIELDS);

		expect(put.body.data.paymentNotice).toBe('Kept');
	});

	it.each([
		['too long', 'x'.repeat(NOTICE_MAX_LENGTH + 1)],
		['non-string', { $ne: null }],
	])('rejects a %s notice', async (_label, checkoutNotice) => {
		const { cookies } = await makeAdminSession(app);

		const res = await request(app)
			.put('/api/admin/settings')
			.set('Cookie', cookies)
			.send({ ...PAYMENT_FIELDS, checkoutNotice });

		expect(res.status).toBe(400);
		expect(await Settings.countDocuments()).toBe(0);
	});
});
