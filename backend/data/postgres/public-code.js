/**
 * Public code and slug on Postgres. The columns are NOT NULL and unique, so the
 * state the Mongo backfill repairs (a row without a code) cannot exist here: the
 * backfill functions are kept so the one-off tooling runs on either backend, and
 * find nothing to do.
 *
 * The draw is looked up on the util module object, not destructured, so a test
 * can stub it as it does on Mongo.
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
 * The backfill set for one model delegate (`prisma.product`, `prisma.combo`).
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
