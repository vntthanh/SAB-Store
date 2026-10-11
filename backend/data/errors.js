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

module.exports = { InvalidIdError, isDuplicateKeyError };
