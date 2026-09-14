/**
 * Coercion helpers for untrusted query-string input.
 *
 * Express hands query values through as strings, arrays or objects depending on
 * what the caller sent, so `{ status: { $ne: null } }` arrives as a live Mongo
 * operator if it is passed into a query unexamined. Every helper here returns
 * either a value of the expected primitive type or `undefined`, so a rejected
 * input drops the filter instead of reshaping the query.
 *
 * Callers should spread the result and let `undefined` disappear:
 *   const filter = { ...(status && { status }) };
 */

/** Return `v` as a string capped at `max` characters, or undefined if it is not a string. */
const asString = (v, max = 100) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** Return `v` only when it is one of `allowed`, otherwise undefined. */
const asEnum = (v, allowed) => (allowed.includes(v) ? v : undefined);

/**
 * Build a Mongo sort object from untrusted field/direction input.
 *
 * An unrecognised field falls back to `fallback` rather than being dropped, so
 * the query keeps a deterministic order instead of relying on natural order.
 */
const asSort = (field, dir, allowed, fallback = 'createdAt') => ({
	[allowed.includes(field) ? field : fallback]: dir === 'asc' ? 1 : -1,
});

/** Clamp pagination input to sane bounds; non-numeric input falls back to page 1, limit 20. */
const asPageLimit = (p, l, maxLimit = 100) => ({
	page: Math.max(1, parseInt(p, 10) || 1),
	limit: Math.min(maxLimit, Math.max(1, parseInt(l, 10) || 20)),
});

/** Return a valid Date, or undefined for anything unparseable. */
const asDate = (v) => {
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? undefined : d;
};

/** Escape regex metacharacters so user input cannot alter the pattern's meaning. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a case-insensitive "contains" matcher from user input.
 *
 * The input is escaped first: an unescaped search term like `.*` would
 * otherwise scan the whole collection, and a nested quantifier can hang the
 * process outright.
 */
const safeSearch = (v, max = 100) => {
	const s = asString(v, max);
	return s ? { $regex: escapeRegExp(s), $options: 'i' } : undefined;
};

module.exports = {
	asString,
	asEnum,
	asSort,
	asPageLimit,
	asDate,
	escapeRegExp,
	safeSearch,
};
