/**
 * The store's single settings row on Postgres: the same functions, arguments
 * and plain records as data/mongo/settings.js. The row stays keyed by SETTINGS_KEY.
 *
 * Unset versus hidden: NULL in a notice, contact or title column means "never
 * set" and `''` a deliberate choice to hide the box. `findStorefront` returns the
 * stored values (NULL as an absent key); `findConfig` and `upsertConfig` fill the
 * code defaults with a null check, never `||`, so `''` stays hidden.
 *
 * Partial first upsert: Mongo creates the row from the fields given plus the
 * schema defaults and leaves the bank details unset without any error. The bank
 * columns are NOT NULL here, so an unset bank detail is stored as `''` and read
 * back as an absent key. That cannot be confused with a real value: the bank
 * fields are required and trimmed on every write, so `''` never comes from a
 * validated one.
 *
 * Rules (trim, lengths, required) are checked in `upsertConfig`, the only writer
 * of this table, with the messages of the schema they replace. No DB CHECKs: a
 * CHECK cannot trim, and the one writer already refuses every value they would.
 */
const { prisma } = require('../../lib/prisma');
const {
	SETTINGS_KEY, DEFAULT_STORE_TITLE, STORE_TITLE_MAX_LENGTH, NOTICE_MAX_LENGTH, DEFAULT_NOTICES, DEFAULT_CONTACT, DEFAULT_PREFIX_MESSAGE, DEFAULT_UPDATED_BY, NOTICE_FIELDS, CONTACT_FIELDS, GOOGLE_CLIENT_ID_FIELD, STOREFRONT_FIELDS
} = require('../../constants/settings');
const { translating } = require('./errors');
const { Problems, checkText } = require('./rules');

const REQUIRED_TEXT = {
	bankNameId: 'Path `bankNameId` is required.',
	bankAccountId: 'Path `bankAccountId` is required.',
	prefixMessage: 'Path `prefixMessage` is required.'
};
const BANK_FIELDS = ['bankNameId', 'bankAccountId'];

const DEFAULTS = { storeTitle: DEFAULT_STORE_TITLE, ...DEFAULT_NOTICES, ...DEFAULT_CONTACT, [GOOGLE_CLIENT_ID_FIELD]: '' };

/** A stored row as a plain record. `defaults` substitutes the code defaults for NULL columns. */
function toRecord(row, { defaults }) {
	const { id, ...rest } = row;
	const record = { _id: id };
	for (const [key, value] of Object.entries(rest)) {
		if (BANK_FIELDS.includes(key) && value === '') continue;
		if (value === null) {
			if (defaults && key in DEFAULTS) record[key] = DEFAULTS[key];
			continue;
		}
		record[key] = value;
	}
	return record;
}

const storefrontSelect = Object.fromEntries(['id', ...STOREFRONT_FIELDS].map((field) => [field, true]));

/**
 * The storefront fields only, as stored: a field that was never set is absent,
 * so the caller applies the defaults. Null when there is no row.
 *
 * @returns {Promise<object|null>}
 */
async function findStorefront() {
	const row = await prisma.settings.findUnique({ where: { key: SETTINGS_KEY }, select: storefrontSelect });
	return row ? toRecord(row, { defaults: false }) : null;
}

/**
 * The whole row with the code defaults applied to unset fields, or null when
 * there is none.
 *
 * @returns {Promise<object|null>}
 */
async function findConfig() {
	const row = await prisma.settings.findUnique({ where: { key: SETTINGS_KEY } });
	return row ? toRecord(row, { defaults: true }) : null;
}

/** Cleaned values for the fields given; only those are checked. @throws {RecordValidationError} */
function valuesOf(fields) {
	const problems = new Problems();
	const required = (name) => checkText(problems, name, fields[name], { required: true, requiredMessage: REQUIRED_TEXT[name] });
	const notice = (name) => checkText(problems, name, fields[name], {
		trim: false, max: NOTICE_MAX_LENGTH, maxMessage: `Path \`${name}\` is longer than the maximum allowed length (${NOTICE_MAX_LENGTH}).`
	});
	const contact = (name) => checkText(problems, name, fields[name], {});

	const values = {
		bankNameId: required('bankNameId'),
		bankAccountId: required('bankAccountId'),
		prefixMessage: required('prefixMessage'),
		storeTitle: checkText(problems, 'storeTitle', fields.storeTitle, {
			required: false, max: STORE_TITLE_MAX_LENGTH, maxMessage: `Path \`storeTitle\` is longer than the maximum allowed length (${STORE_TITLE_MAX_LENGTH}).`
		}),
		...Object.fromEntries(NOTICE_FIELDS.map((name) => [name, notice(name)])),
		...Object.fromEntries(CONTACT_FIELDS.map((name) => [name, contact(name)])),
		[GOOGLE_CLIENT_ID_FIELD]: contact(GOOGLE_CLIENT_ID_FIELD),
		updatedBy: checkText(problems, 'updatedBy', fields.updatedBy ?? undefined, { trim: false })
	};
	// Mongoose's minlength: a title given as text must keep at least one character once trimmed.
	if (typeof values.storeTitle === 'string' && values.storeTitle === '') {
		problems.add('storeTitle', 'Path `storeTitle` is shorter than the minimum allowed length (1).');
	}
	problems.throwIfAny();
	return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

/**
 * Applies `fields` to the row, creating it when missing, and returns the result
 * with the defaults applied. Fields not given keep their stored value; on the
 * first call they take their defaults.
 *
 * @param {object} fields
 * @returns {Promise<object>}
 * @throws {RecordValidationError}
 */
function upsertConfig(fields) {
	return translating(async () => {
		const values = valuesOf(fields);
		const row = await prisma.settings.upsert({
			where: { key: SETTINGS_KEY },
			create: {
				key: SETTINGS_KEY,
				prefixMessage: DEFAULT_PREFIX_MESSAGE,
				updatedBy: DEFAULT_UPDATED_BY,
				bankNameId: '',
				bankAccountId: '',
				...DEFAULTS,
				...values
			},
			update: values
		});
		return toRecord(row, { defaults: true });
	});
}

module.exports = { toRecord, findStorefront, findConfig, upsertConfig };
