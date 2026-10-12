/**
 * Record ids are 24-character hex strings (Mongo ObjectIds) on the mongo backend
 * and UUIDs (v7, a native `uuid` column) on the postgres one. Lowercase is the
 * canonical form. A value of the other shape is refused here, before it reaches
 * a query: Postgres would fail it with 22P02 instead of matching nothing.
 */
const { InvalidIdError } = require('./errors');
const { backendName } = require('./backend-name');

const HEX_ID = /^[0-9a-f]{24}$/i;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD_ID = backendName === 'postgres' ? UUID_ID : HEX_ID;

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
