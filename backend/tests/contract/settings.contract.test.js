/**
 * The settings repository, run against whichever backend DATA_BACKEND selects.
 * A field never set is "unset" (the caller shows the code default); an empty
 * string is the admin's deliberate "hide this".
 */
const { settings } = require('../../data');
const { RecordValidationError } = require('../../data/errors');
const { DEFAULT_STORE_TITLE, DEFAULT_NOTICES, DEFAULT_CONTACT, NOTICE_FIELDS, CONTACT_FIELDS, STORE_TITLE_MAX_LENGTH, NOTICE_MAX_LENGTH } = require('../../constants/settings');
const { insertRawSettings, findSettings, countRows } = require('../helpers/db');

const POSTGRES = process.env.DATA_BACKEND === 'postgres';

afterAll(async () => {
	if (POSTGRES) await require('../../lib/prisma').closeDb();
});

const BANK = { bankNameId: 'MB', bankAccountId: '0123456789' };
const DEFAULTS = { storeTitle: DEFAULT_STORE_TITLE, ...DEFAULT_NOTICES, ...DEFAULT_CONTACT };
const failure = (promise) => promise.then(() => { throw new Error('expected the call to reject'); }, (error) => error);

describe('reading a stored row', () => {
	it('answers null when there is no row', async () => {
		expect(await settings.findStorefront()).toBeNull();
		expect(await settings.findConfig()).toBeNull();
	});

	it('returns only the stored storefront values and never the bank details', async () => {
		await insertRawSettings({ ...BANK, paymentNotice: 'Pay soon', storeTitle: 'My shop' });

		const storefront = await settings.findStorefront();

		expect(storefront).toEqual({ _id: expect.any(String), paymentNotice: 'Pay soon', storeTitle: 'My shop' });
	});

	it('leaves a field the row never set out of the storefront and fills its default in the config', async () => {
		await insertRawSettings(BANK);

		const storefront = await settings.findStorefront();
		const config = await settings.findConfig();

		for (const field of Object.keys(DEFAULTS)) expect(storefront, field).not.toHaveProperty(field);
		expect(config).toMatchObject({ ...BANK, ...DEFAULTS });
	});

	it('keeps an empty string as stored while a neighbouring unset field gets its default', async () => {
		await insertRawSettings({ ...BANK, eventNotice: '', contactEmail: '', contactFacebookUrl: '' });

		const storefront = await settings.findStorefront();
		const config = await settings.findConfig();

		expect(storefront).toMatchObject({ eventNotice: '', contactEmail: '', contactFacebookUrl: '' });
		expect(storefront).not.toHaveProperty('checkoutNotice');
		expect(config).toMatchObject({ eventNotice: '', contactEmail: '', contactFacebookUrl: '', checkoutNotice: DEFAULT_NOTICES.checkoutNotice });
	});

	it('reads the row under the application key only', async () => {
		await insertRawSettings({ ...BANK, key: 'another_key' });

		expect(await settings.findConfig()).toBeNull();
	});

	it.skipIf(!POSTGRES)('treats NULL like a field that was never set', async () => {
		await insertRawSettings({ ...BANK, eventNotice: null, storeTitle: null, contactEmail: null, paymentNotice: '' });

		const storefront = await settings.findStorefront();
		const config = await settings.findConfig();

		expect(storefront).toMatchObject({ paymentNotice: '' });
		for (const field of ['eventNotice', 'storeTitle', 'contactEmail']) expect(storefront, field).not.toHaveProperty(field);
		expect(config).toMatchObject({ eventNotice: DEFAULT_NOTICES.eventNotice, storeTitle: DEFAULT_STORE_TITLE, contactEmail: DEFAULT_CONTACT.contactEmail, paymentNotice: '' });
	});
});

describe('upsertConfig', () => {
	it('creates the row from the given fields with the defaults for the rest', async () => {
		const saved = await settings.upsertConfig({ ...BANK, prefixMessage: 'SABX', updatedBy: 'admin' });

		expect(await countRows('settings')).toBe(1);
		expect(saved).toMatchObject({ ...BANK, prefixMessage: 'SABX', updatedBy: 'admin', ...DEFAULTS });
		expect(Object.keys(saved).filter((key) => key !== '__v').sort()).toEqual([
			'_id', 'bankAccountId', 'bankNameId', 'checkoutNotice', 'contactEmail', 'contactFacebookUrl', 'createdAt', 'eventNotice', 'googleClientId', 'key',
			'paymentNotice', 'prefixMessage', 'storeTitle', 'updatedAt', 'updatedBy',
		]);
		expect(saved.createdAt).toBeInstanceOf(Date);
		expect(await findSettings()).toMatchObject(DEFAULTS);
		expect(await settings.findConfig()).toEqual(saved);
	});

	it('creates the row from a partial first call without bank details and without an error', async () => {
		const saved = await settings.upsertConfig({ updatedBy: 'tester' });

		expect(await countRows('settings')).toBe(1);
		expect(saved).toMatchObject({ ...DEFAULTS, prefixMessage: 'SAB', updatedBy: 'tester' });
		expect(saved.bankNameId).toBeUndefined();
		expect(saved.bankAccountId).toBeUndefined();
		expect(await findSettings()).toMatchObject(DEFAULTS);
		expect((await settings.findConfig()).bankNameId).toBeUndefined();
	});

	it('changes only the fields given and keeps a hidden notice hidden', async () => {
		await settings.upsertConfig({ ...BANK, eventNotice: '', contactEmail: 'shop@example.com' });

		const saved = await settings.upsertConfig({ storeTitle: 'Renamed' });

		expect(saved).toMatchObject({ ...BANK, eventNotice: '', contactEmail: 'shop@example.com', storeTitle: 'Renamed', paymentNotice: DEFAULT_NOTICES.paymentNotice });
		expect(await countRows('settings')).toBe(1);
	});

	it('trims the bank details, the title and the contact fields but not the notices', async () => {
		const saved = await settings.upsertConfig({
			bankNameId: '  MB ', bankAccountId: ' 123 ', prefixMessage: ' SAB ', storeTitle: '  Shop  ', contactEmail: ' a@b.vn ', contactFacebookUrl: ' https://x.vn ', paymentNotice: '  keep  ',
		});

		expect(saved).toMatchObject({
			bankNameId: 'MB', bankAccountId: '123', prefixMessage: 'SAB', storeTitle: 'Shop', contactEmail: 'a@b.vn', contactFacebookUrl: 'https://x.vn', paymentNotice: '  keep  ',
		});
	});

	it('moves updatedAt forward on a later call and keeps createdAt', async () => {
		const first = await settings.upsertConfig(BANK);
		await new Promise((resolve) => setTimeout(resolve, 5));

		const second = await settings.upsertConfig({ prefixMessage: 'NEW' });

		expect(second._id).toBe(first._id);
		expect(second.createdAt).toEqual(first.createdAt);
		expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
		expect(await findSettings()).toMatchObject({ prefixMessage: 'NEW' });
	});

	it('keeps one row when two first calls race', async () => {
		await Promise.all([settings.upsertConfig(BANK), settings.upsertConfig({ ...BANK, prefixMessage: 'RACE' })]);

		expect(await countRows('settings')).toBe(1);
	});

	it.each([
		['a title longer than the limit', { storeTitle: 'x'.repeat(STORE_TITLE_MAX_LENGTH + 1) }, 'storeTitle'],
		['a title that is blank once trimmed', { storeTitle: '   ' }, 'storeTitle'],
		['a notice longer than the limit', { checkoutNotice: 'x'.repeat(NOTICE_MAX_LENGTH + 1) }, 'checkoutNotice'],
		['an empty bank name', { bankNameId: '  ' }, 'bankNameId'],
		['an empty prefix', { prefixMessage: '' }, 'prefixMessage'],
	])('refuses %s', async (_label, fields, field) => {
		const error = await failure(settings.upsertConfig({ ...BANK, ...fields }));

		expect(error).toBeInstanceOf(RecordValidationError);
		expect(error.fieldErrors.map((entry) => entry.field)).toEqual([field]);
		expect(await countRows('settings')).toBe(0);
	});

	it('accepts a title and a notice exactly at their limits', async () => {
		const saved = await settings.upsertConfig({ ...BANK, storeTitle: 'x'.repeat(STORE_TITLE_MAX_LENGTH), eventNotice: 'y'.repeat(NOTICE_MAX_LENGTH) });

		expect(saved.storeTitle).toHaveLength(STORE_TITLE_MAX_LENGTH);
		expect(saved.eventNotice).toHaveLength(NOTICE_MAX_LENGTH);
	});

	// Mongo writes whatever the caller names; the admin route and the seed only ever name settings.
	it.skipIf(!POSTGRES)('ignores a field that is not a setting', async () => {
		const saved = await settings.upsertConfig({ ...BANK, key: 'elsewhere', createdAt: new Date(0), unrelated: 1 });

		expect(saved.key).toBe('payment_config');
		expect(saved.createdAt.getTime()).toBeGreaterThan(0);
		expect(saved).not.toHaveProperty('unrelated');
	});

	it('lists the notice and contact fields as the storefront returns them', () => {
		expect([...NOTICE_FIELDS, ...CONTACT_FIELDS]).toEqual(['checkoutNotice', 'eventNotice', 'paymentNotice', 'contactEmail', 'contactFacebookUrl']);
	});
});
