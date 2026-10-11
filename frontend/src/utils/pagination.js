/**
 * What a list footer shows for the `meta` of a `{ data, meta }` response:
 * the 1-based row range on this page and whether Previous/Next apply.
 * An empty result has no range (from and to are 0).
 */
export function describePage({ page, limit, total, totalPages }) {
	if (total === 0) return { from: 0, to: 0, hasPrev: false, hasNext: false };
	return {
		from: (page - 1) * limit + 1,
		to: Math.min(page * limit, total),
		hasPrev: page > 1,
		hasNext: page < totalPages
	};
}
