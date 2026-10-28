/**
 * Public code and slug on Postgres. The columns are NOT NULL and unique, so a row
 * without a code cannot exist here: the repair functions (`listWithoutPublicCode`,
 * `assignMissingPublicCode`, `ensureIndexes`) keep a stable shape for the
 * contract tests and find nothing to do.
 *
 * The draw is looked up on the util module object, not destructured, so a test
 * can stub it.
 */
const publicCodeUtil = require('../../utils/public-code');

/**
 * The code and slug a new row is written with. A code the caller supplies (a
 * restore) is kept: redrawing could not fix a code that is not random.
 *
 * @param {string} name already trimmed
 * @param {string} [suppliedCode]
 * @returns {{publicCode: string, slug: string}}
 */
function drawCodeAndSlug(name, suppliedCode) {
	const publicCode = suppliedCode || publicCodeUtil.generatePublicCode();
	return { publicCode, slug: publicCodeUtil.makeSlug(name, publicCode) };
}

/** The slug of a renamed row: follows the new name and keeps the stored code. */
const slugFor = (name, storedCode) => publicCodeUtil.makeSlug(name, storedCode);

/**
 * The repair set (no-ops here) for one model delegate (`prisma.product`, `prisma.combo`).
 *
 * @param {() => object} delegate resolves the Prisma model delegate
 */
function publicCodeBackfill(delegate) {
	return {
		count() {
			return delegate().count();
		},
		async listWithoutPublicCode() {
			return [];
		},
		async assignMissingPublicCode() {
			return false;
		},
		async ensureIndexes() {}
	};
}

module.exports = { drawCodeAndSlug, slugFor, publicCodeBackfill };
