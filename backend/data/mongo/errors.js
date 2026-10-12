/**
 * Translation of Mongoose/driver write errors into the domain errors of
 * data/errors.js, so callers never test `error.name` or `error.code`.
 */
const { InvalidIdError, DuplicateKeyError, RecordValidationError, indexFields } = require('../errors');

/**
 * The domain error for `err`, or `err` itself when it is not one of the three
 * the callers handle (connection failures, transient transaction errors and the
 * like pass through untouched, labels included).
 *
 * @param {unknown} err
 * @returns {unknown}
 */
function translateWriteError(err) {
	if (!err || typeof err !== 'object') return err;

	if (err.name === 'ValidationError' && err.errors) {
		const fieldErrors = Object.values(err.errors).map((entry) => ({ field: entry.path, message: entry.message }));
		return new RecordValidationError(fieldErrors, { cause: err });
	}

	if (err.name === 'CastError') {
		return new InvalidIdError(`Invalid value for ${err.path}`, { path: err.path, value: err.value });
	}

	if (err.code === 11000) {
		return new DuplicateKeyError(indexFields(err), { cause: err });
	}

	return err;
}

/**
 * Run `operation` and rethrow its failure as a domain error.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function translating(operation) {
	try {
		return await operation();
	} catch (err) {
		throw translateWriteError(err);
	}
}

module.exports = { translating, translateWriteError };
