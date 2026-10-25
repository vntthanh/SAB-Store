/**
 * Errors the repositories raise instead of leaking the storage engine's own.
 */

/**
 * A value could not be stored as the type its field has. For an id, no lookup
 * was attempted. `path` names the field and `value` is what was supplied, so a
 * handler can say which input was refused.
 */
class InvalidIdError extends Error {
	/**
	 * @param {string} [message]
	 * @param {{path?: string, value?: unknown}} [details]
	 */
	constructor(message = 'Invalid record id', { path, value } = {}) {
		super(message);
		this.name = 'InvalidIdError';
		this.path = path;
		this.value = value;
	}
}

/** A write broke a unique constraint. `fields` names the clashing columns, never the values. */
class DuplicateKeyError extends Error {
	/**
	 * @param {string[]} fields
	 * @param {{cause?: unknown}} [options]
	 */
	constructor(fields, options) {
		super(`Duplicate value for: ${fields.join(', ')}`, options);
		this.name = 'DuplicateKeyError';
		this.fields = fields;
	}
}

/** A write was refused by the schema's rules. Messages are the user-facing ones, in field order. */
class RecordValidationError extends Error {
	/**
	 * @param {{field: string, message: string}[]} fieldErrors
	 * @param {{cause?: unknown}} [options]
	 */
	constructor(fieldErrors, options) {
		super(fieldErrors.map((entry) => entry.message).join(', '), options);
		this.name = 'RecordValidationError';
		this.fieldErrors = fieldErrors;
	}
}

/**
 * A write was refused by a rule about the rest of the store, not about one value:
 * a row other rows still point at, a last remaining row, a reference to a row that
 * does not exist. `code` is one of CONFLICT_CODES; `details` carries counts or
 * names the caller may show, never row contents.
 */
const CONFLICT_CODES = Object.freeze({
	STOREFRONT_IN_USE: 'STOREFRONT_IN_USE',
	LAST_ACTIVE_STOREFRONT: 'LAST_ACTIVE_STOREFRONT',
	DEFAULT_STOREFRONT: 'DEFAULT_STOREFRONT',
	REFERENCE_VIOLATION: 'REFERENCE_VIOLATION'
});

class ConflictError extends Error {
	/**
	 * @param {string} code a CONFLICT_CODES value
	 * @param {string} message
	 * @param {{details?: object, cause?: unknown}} [options]
	 */
	constructor(code, message, { details, cause } = {}) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'ConflictError';
		this.code = code;
		this.details = details;
	}
}

/**
 * True when `err` reports a unique-constraint violation. Callers ask this
 * instead of looking at an engine-specific error code. Repositories that
 * translate their errors raise `DuplicateKeyError`; the ones not yet converted
 * let the engine's own error through, so this also recognises that signal
 * (MongoDB E11000).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isDuplicateKeyError(err) {
	return err instanceof DuplicateKeyError || (Boolean(err) && err.code === 11000);
}

/**
 * The field(s) a unique-constraint violation names, without the clashing value,
 * for an error that `isDuplicateKeyError` recognises. Falls back to a generic
 * phrase when the engine did not say.
 *
 * @param {unknown} err
 * @returns {string}
 */
function duplicateKeyFields(err) {
	if (err instanceof DuplicateKeyError) return err.fields.join(', ') || UNKNOWN_KEY_LABEL;
	return indexFields(err).join(', ') || UNKNOWN_KEY_LABEL;
}

const UNKNOWN_KEY_LABEL = 'khoá duy nhất';

/**
 * True when `err` is a unique-constraint violation on one of the named columns.
 * A retry loop asks this so it re-draws only for the collision it knows how to
 * fix; a clash on another column (or one that names no column) is not its to retry.
 *
 * @param {unknown} err
 * @param {...string} fields
 * @returns {boolean}
 */
function isDuplicateKeyOn(err, ...fields) {
	if (!isDuplicateKeyError(err)) return false;
	const named = err instanceof DuplicateKeyError ? err.fields : indexFields(err);
	return named.some((field) => fields.includes(field));
}

/**
 * The column names a duplicate-key error is about, or none when it does not say.
 * A bulk write reports only the message ("... index: a_1_b_1 dup key: { ... }");
 * an index name is its fields each followed by a direction, so `a_1_b_-1` is a, b.
 *
 * @param {unknown} err
 * @returns {string[]}
 */
function indexFields(err) {
	if (err && err.keyPattern) return Object.keys(err.keyPattern);
	const index = /index: (\S+)/.exec(String(err && err.message));
	return index ? [...index[1].matchAll(/(.+?)_-?\d+(?:_|$)/g)].map((part) => part[1]) : [];
}

module.exports = { InvalidIdError, DuplicateKeyError, RecordValidationError, ConflictError, CONFLICT_CODES, isDuplicateKeyError, isDuplicateKeyOn, duplicateKeyFields, indexFields };
