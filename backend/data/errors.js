/**
 * Errors the repositories raise instead of leaking the storage engine's own.
 */

/** An id was not shaped like a record id, so no lookup was attempted. */
class InvalidIdError extends Error {
	/** @param {string} [message] */
	constructor(message = 'Invalid record id') {
		super(message);
		this.name = 'InvalidIdError';
	}
}

/**
 * True when `err` reports a unique-constraint violation. Callers ask this
 * instead of looking at an engine-specific error code. The repositories let the
 * engine's own error through, so this recognises that signal (MongoDB E11000).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isDuplicateKeyError(err) {
	return Boolean(err) && err.code === 11000;
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
	if (err && err.keyPattern) return Object.keys(err.keyPattern).join(', ');
	// A bulk write reports only the message: "... index: orderCode_1 dup key: { ... }".
	const index = /index: (\S+)/.exec(String(err && err.message));
	return index ? index[1].replace(/_-?\d+$/, '') : 'khoá duy nhất';
}

module.exports = { InvalidIdError, isDuplicateKeyError, duplicateKeyFields };
