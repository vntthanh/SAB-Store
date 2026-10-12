import { z } from '../z.js';
import { isRecordId } from '../ids.js';

export const isPlainObject = (value) =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

// Runs `schema` only once the value is known to be a string. Without the gate a
// wrong type (an array, say, which has a length) would fail every rule in the
// chain and report the same message several times.
export const onlyStrings = (message, schema) => z.string({ error: message }).pipe(schema);

// A missing or null text field is validated as '' so it reports its required
// message and its format message together.
export const nullishAsEmpty = (schema) =>
	z.preprocess((value) => (value === undefined || value === null ? '' : value), schema);

// Form inputs and older clients send whole numbers as digit strings. Only that
// exact shape is converted: z.coerce.number() would also turn '', null, true
// and [] into numbers and let them through.
const DIGITS = /^\d+$/;
export const digitStringAsNumber = (schema) =>
	z.preprocess((value) => (typeof value === 'string' && DIGITS.test(value) ? Number(value) : value), schema);

/**
 * A whole number in [min, max]. One refinement, not separate int/min/max
 * checks, so an out-of-range value reports a single message instead of one per
 * violated bound. Accepts digit strings.
 */
export function wholeNumber({ min, max = Number.MAX_SAFE_INTEGER, message }) {
	return digitStringAsNumber(
		z.number({ error: message }).refine((n) => Number.isSafeInteger(n) && n >= min && n <= max, message),
	);
}

// A record id as a request carries it: a UUID (the id on Postgres) or a legacy
// 24-hex id (carts, links and backups made before the move). Which one the store
// actually accepts is decided behind the validation, by the repository.
// Case does not matter (a link or cart may carry an uppercase id); the store lowercases it.
export const recordId = (message) =>
	z.string({ error: message }).refine((value) => isRecordId(value.toLowerCase()), message);

// An array element that is not an object reports every field of the element,
// rather than one "expected object" error.
export const arrayElement = (shape) =>
	z.preprocess((value) => (isPlainObject(value) ? value : {}), z.object(shape));

/** Optional free text, trimmed before its length is checked. */
export function optionalText({ max, typeMessage, maxMessage, nullable = true }) {
	const text = onlyStrings(typeMessage, z.string().trim().max(max, maxMessage));
	return nullable ? text.nullish() : text.optional();
}
