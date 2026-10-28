/**
 * Substring search on text columns.
 *
 * Prisma does not escape the pattern characters of `contains` (measured, see
 * tests/contract/catalog.contract.test.js): it compiles the value into `LIKE` or
 * `ILIKE` verbatim, so `%` would match every row and `_` any single character.
 * The value is escaped here, once, so what the user typed is matched literally.
 */

/**
 * Escape the characters `LIKE` treats as syntax. Backslash is Postgres' default
 * escape character; one pass escapes all three, so a backslash added here is
 * never escaped a second time.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeLike(value) {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Prisma filter for "contains `value`", ignoring case. Neither side ignores
 * diacritics, and `value` is not trimmed.
 *
 * @param {string} value
 * @returns {{contains: string, mode: 'insensitive'}}
 */
function containsInsensitive(value) {
	return { contains: escapeLike(value), mode: 'insensitive' };
}

module.exports = { escapeLike, containsInsensitive };
