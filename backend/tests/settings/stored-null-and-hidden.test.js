const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeSettings } = require('../helpers/factories');
const { settingsDefaults, insertRawSettings } = require('../helpers/db');

const PAYMENT_FIELDS = { bankNameId: 'MB', bankAccountId: '0123456789', prefixMessage: 'SAB' };
const { notices, contact } = settingsDefaults;

// A missing field (NULL on SQL) means "never set": the customer API shows the
// default. An empty string is the admin's deliberate "hide this". The factory
// writes both shapes as given, with no schema default filling the gap.
describe('storefront settings read from a stored row', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('serves the default for every field the row leaves unset', async () => {
		await makeSettings(PAYMENT_FIELDS);

		const res = await request(app).get('/api/settings').expect(200);

		expect(res.body.data).toMatchObject({ ...notices, ...contact, storeTitle: 'SAB Store' });
	});

	it('keeps an empty string hidden while a neighbouring unset field still gets its default', async () => {
		await makeSettings({
			...PAYMENT_FIELDS,
			eventNotice: '',
			contactEmail: '',
			contactFacebookUrl: '',
		});

		const res = await request(app).get('/api/settings').expect(200);

		expect(res.body.data).toMatchObject({
			eventNotice: '',
			contactEmail: '',
			contactFacebookUrl: '',
			checkoutNotice: notices.checkoutNotice,
			paymentNotice: notices.paymentNotice,
		});
	});

	// A SQL column holds NULL, and Mongo can hold an explicit null: both mean "never set".
	it('treats a stored null like an unset field and still keeps an empty string hidden', async () => {
		await insertRawSettings({
			...PAYMENT_FIELDS,
			eventNotice: null,
			paymentNotice: '',
			contactEmail: null,
			storeTitle: null,
		});

		const res = await request(app).get('/api/settings').expect(200);

		expect(res.body.data).toMatchObject({
			eventNotice: notices.eventNotice,
			paymentNotice: '',
			contactEmail: contact.contactEmail,
			storeTitle: 'SAB Store',
		});
	});
});
