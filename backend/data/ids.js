/**
 * Record ids are 24-character hex strings in both stores: Mongo ObjectIds today,
 * `substr(replace(gen_random_uuid()::text, '-', ''), 1, 24)` in Postgres, so
 * documents and rows keep the ids that already appear in URLs and exports.
 * Lowercase is the canonical form.
 */
const { InvalidIdError } = require('./errors');

const RECORD_ID = /^[0-9a-f]{24}$/i;

/**
 * True for a record id as a string, or an id object whose string form is one
 * (a Mongo ObjectId). Anything else, including arrays and plain objects, is not.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecordId(value) {
	if (typeof value === 'string') return RECORD_ID.test(value);
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	if (value.toString === Object.prototype.toString) return false;
	return RECORD_ID.test(String(value));
}

/**
 * The canonical (lowercase string) form of a record id.
 *
 * @param {unknown} value
 * @returns {string}
 * @throws {InvalidIdError}
 */
function normalizeRecordId(value) {
	if (!isRecordId(value)) throw new InvalidIdError();
	return String(value).toLowerCase();
}

module.exports = { isRecordId, normalizeRecordId };
