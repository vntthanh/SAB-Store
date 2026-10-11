import { z } from '../z.js';

/** Ceiling on `limit`: the largest page a list request may ask for. */
export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 20;

// Far beyond any real list, low enough that `(page - 1) * limit` stays inside a
// 32-bit `skip` (what Prisma accepts) instead of reaching the database as an
// overflow error.
const MAX_PAGE = 1_000_000;

// parseInt, not Number(): a query string such as '3abc' or ['3'] must keep
// resolving the way it always has, and 0, NaN and non-strings fall to the default.
const clampedInt = ({ min, max, fallback }) =>
	z.preprocess((value) => {
		const n = parseInt(value, 10) || fallback;
		return Math.min(max, Math.max(min, n));
	}, z.number().int().min(min).max(max));

/**
 * Page and limit of a list request. Out-of-range or unreadable input is clamped,
 * never rejected: list endpoints answered '?limit=9999' with the last allowed
 * page long before this schema existed, so a 400 would break their clients.
 * Plain `z.coerce` is avoided on purpose (it would turn '' and null into 0).
 * Always succeeds, so callers may use `.parse` without a try/catch.
 */
export const paginationQuery = z.object({
	page: clampedInt({ min: 1, max: MAX_PAGE, fallback: 1 }),
	limit: clampedInt({ min: 1, max: MAX_PAGE_LIMIT, fallback: DEFAULT_PAGE_LIMIT }),
});

/** `{ page, limit }` in the units of an offset query; storage-neutral (Prisma and Mongo both take skip/limit). */
export function toSkipTake(page, limit) {
	return { skip: (page - 1) * limit, take: limit };
}

/** The `meta` of a `{ data, meta }` list response. An empty result has `totalPages: 0`. */
export function buildPaginationMeta(total, { page, limit }) {
	return { page, limit, total, totalPages: Math.ceil(total / limit) };
}
