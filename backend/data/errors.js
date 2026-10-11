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

module.exports = { InvalidIdError, DuplicateKeyError, RecordValidationError, isDuplicateKeyError, duplicateKeyFields, indexFields };
