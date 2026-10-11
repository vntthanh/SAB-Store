/**
 * The store's single settings row: payment details plus the storefront texts.
 * The row stays keyed by SETTINGS_KEY.
 *
 * Contract:
 * - A field is "not set" when missing (or NULL on another backend) and "hidden"
 *   when it is the empty string. `findStorefront` returns stored values only, so
 *   its caller substitutes the code defaults, with a null check and never `||`:
 *   `''` must stay hidden. (`storeTitle` may use `||`: it cannot be empty.)
 * - `findConfig` and `upsertConfig` return the row with the code defaults
 *   already applied, again only for missing/NULL fields, never for `''`.
 * - `upsertConfig` validates only the fields it is given (Mongoose checks the
 *   `$set` keys). On a first call that creates the row, fields absent from the
 *   call get their defaults where the schema has one, and bankNameId and
 *   bankAccountId are left unset without any error: the NOT NULL rule is not
 *   enforced on an upsert. The admin route cannot reach that state because it
 *   refuses a PUT without the bank fields. Another backend must either keep
 *   that behaviour or turn a missing required bank field into
 *   `RecordValidationError`, never into a raw database error.
 * - Length, trim and min/max rules (`storeTitle` 1..STORE_TITLE_MAX_LENGTH,
 *   notices up to NOTICE_MAX_LENGTH, trimmed bank fields) are enforced by the
 *   Mongoose schema on write, and the admin route checks them first. Another
 *   backend needs DB CHECK constraints or repository validation for parity.
 */
const Settings = require('../../models/Settings');
const { SETTINGS_KEY, STOREFRONT_FIELDS } = require('../../constants/settings');
const { withStringId, toRecord } = require('./records');
const { translating } = require('./errors');

/**
 * The storefront fields only, as stored: a row saved before a field existed
 * lacks it, so the caller applies the defaults. Null when there is no row.
 *
 * @returns {Promise<object|null>}
 */
async function findStorefront() {
	const found = await Settings.findOne({ key: SETTINGS_KEY }).select(STOREFRONT_FIELDS).lean();
	return found ? withStringId(found) : null;
}

/**
 * The whole row with the schema defaults applied, or null when there is none.
 *
 * @returns {Promise<object|null>}
 */
async function findConfig() {
	const found = await Settings.findOne({ key: SETTINGS_KEY });
	return found ? toRecord(found) : null;
}

/**
 * Applies `fields` to the row, creating it when missing, and returns the
 * result with the defaults applied.
 *
 * @param {object} fields
 * @returns {Promise<object>}
 * @throws {RecordValidationError}
 */
function upsertConfig(fields) {
	return translating(async () => {
		const saved = await Settings.findOneAndUpdate({ key: SETTINGS_KEY }, fields, {
			new: true,
			upsert: true,
			runValidators: true
		});
		return toRecord(saved);
	});
}

module.exports = { findStorefront, findConfig, upsertConfig };
