/**
 * Translation of Prisma/driver write errors into the domain errors of
 * data/errors.js, so callers never test a Prisma code or a SQLSTATE.
 *
 * Field names follow the record (camelCase), which is also what Mongo reports,
 * so a retry loop asking `isDuplicateKeyOn(err, 'orderCode')` works on both.
 */
const { InvalidIdError, DuplicateKeyError, RecordValidationError } = require('../errors');

const camelCase = (name) => name.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());

// Check constraints are named `<table>_<column>_check`; the column is the field.
const TABLE_PREFIXES = ['products_', 'combos_', 'combo_category_requirements_', 'orders_', 'order_items_', 'stock_movements_'];

const SQLSTATE_CHECK_VIOLATION = '23514';
const SQLSTATE_INVALID_TEXT = '22P02';

/** The SQLSTATE behind an error, wherever the Prisma layer put it. */
function sqlState(err) {
	const meta = err.meta || {};
	const cause = (meta.driverAdapterError && meta.driverAdapterError.cause) || err.cause || {};
	return meta.code || cause.originalCode || cause.code || null;
}

/** Everything the error says about itself, for matching on the database's wording. */
function messageOf(err) {
	const meta = err.meta || {};
	const cause = (meta.driverAdapterError && meta.driverAdapterError.cause) || {};
	return [err.message, meta.message, cause.originalMessage, cause.message].filter(Boolean).join(' ');
}

/**
 * The column(s) of a unique violation. Prisma reports the index name
 * (`<table>_<columns>_key`, `<table>_pkey`), not the columns, so the table
 * prefix and the suffix come off. A compound index has no recoverable column
 * split and is reported as one joined name.
 */
function duplicateFields(err) {
	const meta = err.meta || {};
	const cause = (meta.driverAdapterError && meta.driverAdapterError.cause) || {};
	const constraint = cause.constraint || {};
	if (Array.isArray(meta.target)) return meta.target.map(camelCase);
	if (Array.isArray(constraint.fields)) return constraint.fields.map(camelCase);
	const index = typeof meta.target === 'string' ? meta.target : constraint.index;
	if (!index) return [];
	const withoutTable = cause.table && index.startsWith(`${cause.table}_`) ? index.slice(cause.table.length + 1) : index;
	return [camelCase(withoutTable.replace(/_(?:key|pkey)$/, '') || 'id')];
}

function checkViolation(err) {
	const constraint = /check constraint "([^"]+)"/.exec(messageOf(err));
	const name = constraint ? constraint[1].replace(/_check$/, '') : 'value';
	const prefix = TABLE_PREFIXES.find((table) => name.startsWith(table));
	const field = camelCase(prefix ? name.slice(prefix.length) : name);
	return new RecordValidationError([{ field, message: `Giá trị của "${field}" không hợp lệ` }], { cause: err });
}

/**
 * The domain error for `err`, or `err` itself when it is not one of the three
 * the callers handle (connection failures, timeouts, deadlocks and the like pass
 * through untouched so the transaction wrapper still sees their code).
 *
 * @param {unknown} err
 * @returns {unknown}
 */
function translateWriteError(err) {
	if (!err || typeof err !== 'object') return err;
	const message = messageOf(err);

	if (err.code === 'P2002') return new DuplicateKeyError(duplicateFields(err), { cause: err });

	// A value that is not a uuid, either rejected by the driver (P2023) or by the
	// server (22P02 "type uuid"). The enum flavour of 22P02 is a validation error.
	const badUuid = /\buuid\b/i.test(message) && (err.code === 'P2023' || sqlState(err) === SQLSTATE_INVALID_TEXT || err.name === 'PrismaClientValidationError');
	if (badUuid) {
		const offending = /type uuid: "([^"]*)"/.exec(message);
		return new InvalidIdError('Invalid record id', { value: offending ? offending[1] : undefined });
	}

	if (err.code === 'P2000' || err.code === 'P2011' || err.code === 'P2012') {
		const meta = err.meta || {};
		const field = camelCase(String(meta.column_name || meta.constraint || meta.path || 'value').split('.').pop());
		return new RecordValidationError([{ field, message: `Giá trị của "${field}" không hợp lệ` }], { cause: err });
	}

	if (sqlState(err) === SQLSTATE_CHECK_VIOLATION) return checkViolation(err);

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
