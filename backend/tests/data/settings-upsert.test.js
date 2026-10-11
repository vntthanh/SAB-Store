const { settings } = require('../../data');
const { RecordValidationError } = require('../../data/errors');
const { DEFAULT_NOTICES, DEFAULT_STORE_TITLE } = require('../../constants/settings');
const { countRows } = require('../helpers/db');

describe('settings repository upsert', () => {
	it('creates the row from partial fields, with defaults and without bank details', async () => {
		const saved = await settings.upsertConfig({ updatedBy: 'tester' });

		expect(await countRows('settings')).toBe(1);
		expect(saved.storeTitle).toBe(DEFAULT_STORE_TITLE);
		expect(saved.checkoutNotice).toBe(DEFAULT_NOTICES.checkoutNotice);
		expect(saved.bankNameId).toBeUndefined();
	});

	it('refuses a stored value that breaks a schema rule as RecordValidationError', async () => {
		const error = await settings.upsertConfig({ storeTitle: 'x'.repeat(61) }).catch((e) => e);

		expect(error).toBeInstanceOf(RecordValidationError);
		expect(error.fieldErrors.map((entry) => entry.field)).toEqual(['storeTitle']);
	});
});
