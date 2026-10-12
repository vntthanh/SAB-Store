/**
 * The rules Mongoose enforced on write (trim, required, length, minimum, enum,
 * integer) for the places that reach a repository without passing the request
 * validation first: the database import, the seed and scripts. Messages are the
 * user-facing ones of the schemas they replace. The database keeps CHECKs for
 * money and counts; lengths and trimming live here because a CHECK on a trimmed
 * value would not trim it.
 *
 * Each check returns the cleaned value and records a problem instead of
 * throwing, so a write reports every field it refuses, like a schema does.
 */
const { RecordValidationError, InvalidIdError } = require('../errors');
const { normalizeRecordId } = require('../ids');

const invalid = (field) => `Giá trị của "${field}" không hợp lệ`;

class Problems {
	constructor() {
		this.list = [];
	}

	add(field, message) {
		this.list.push({ field, message });
	}

	/** @throws {RecordValidationError} when anything was recorded */
	throwIfAny() {
		if (this.list.length > 0) throw new RecordValidationError(this.list);
	}
}

/** `undefined` means "not given" and is skipped; `null` is given and, when required, refused. */
function checkText(problems, field, value, { required, requiredMessage, max, maxMessage, trim = true }) {
	if (value === undefined) return undefined;
	if (value === null) {
		if (required) problems.add(field, requiredMessage);
		return null;
	}
	if (typeof value !== 'string') {
		problems.add(field, invalid(field));
		return undefined;
	}
	const text = trim ? value.trim() : value;
	if (required && text === '') problems.add(field, requiredMessage);
	else if (max !== undefined && text.length > max) problems.add(field, maxMessage);
	return text;
}

/** Numbers arrive as numbers or numeric strings (an imported file); anything else is refused. */
function checkNumber(problems, field, value, { required, requiredMessage, min, minMessage, integer, integerMessage }) {
	if (value === undefined) return undefined;
	if (value === null) {
		if (required) problems.add(field, requiredMessage);
		return null;
	}
	const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
	if (!Number.isFinite(number)) {
		problems.add(field, integerMessage || invalid(field));
		return undefined;
	}
	if (min !== undefined && number < min) problems.add(field, minMessage);
	else if (integer && !Number.isInteger(number)) problems.add(field, integerMessage);
	return number;
}

function checkBoolean(problems, field, value) {
	if (value === undefined) return undefined;
	if (typeof value === 'boolean') return value;
	if (value === 'true' || value === 'false') return value === 'true';
	problems.add(field, invalid(field));
	return undefined;
}

function checkEnum(problems, field, value, allowed) {
	if (value === undefined) return undefined;
	if (!allowed.includes(value)) {
		problems.add(field, `\`${String(value)}\` is not a valid enum value for path \`${field}\`.`);
		return undefined;
	}
	return value;
}

function checkDate(problems, field, value) {
	if (value === undefined || value === null) return value;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		problems.add(field, invalid(field));
		return undefined;
	}
	return date;
}

/**
 * The canonical id for a value a caller supplied. A legacy hex id is mapped to
 * its UUID; anything else is an InvalidIdError carrying the path and value,
 * which is what a cast failure reported on the other backend.
 *
 * @throws {InvalidIdError}
 */
function recordId(value, path = '_id') {
	try {
		return normalizeRecordId(value);
	} catch {
		throw new InvalidIdError(`Invalid value for ${path}`, { path, value });
	}
}

module.exports = { Problems, checkText, checkNumber, checkBoolean, checkEnum, checkDate, recordId };
