/**
 * Record ids are UUIDs (v7, a native `uuid` column); lowercase is the canonical
 * form. A value that is not one is refused here, before it reaches a query:
 * Postgres would fail it with 22P02 instead of matching nothing.
 *
 * A legacy 24-hex id (a MongoDB ObjectId) is still accepted and mapped to its UUID
 * with `objectIdToUuidV7`: carts in browsers, idempotency keys, queued jobs and old
 * backup files keep carrying the ids the store had before the move to Postgres,
 * and that move stored every row under the same mapping.
 */
const { objectIdToUuidV7 } = require('@sab/shared');
const { InvalidIdError } = require('./errors');

const HEX_ID = /^[0-9a-f]{24}$/i;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const matches = (text) => UUID_ID.test(text) || HEX_ID.test(text);

/**
 * True for a record id as a string, or an id object whose string form is one.
 * Anything else, including arrays and plain objects, is not.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecordId(value) {
	if (typeof value === 'string') return matches(value);
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	if (value.toString === Object.prototype.toString) return false;
	return matches(String(value));
}

/**
 * The canonical form of a record id: a lowercase UUID (a legacy hex id is mapped,
 * so one row has exactly one id whichever form a caller holds).
 *
 * @param {unknown} value
 * @returns {string}
 * @throws {InvalidIdError}
 */
function normalizeRecordId(value) {
	if (!isRecordId(value)) throw new InvalidIdError();
	const text = String(value).toLowerCase();
	return HEX_ID.test(text) ? objectIdToUuidV7(text) : text;
}

module.exports = { isRecordId, normalizeRecordId };
