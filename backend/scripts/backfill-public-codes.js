/**
 * Give every product and combo created before public codes existed its
 * `publicCode` + `slug`, so its share link works.
 *
 * The repositories write it past the model (see `assignMissingPublicCode` in
 * utils/public-code.js): the field is immutable, so saving a document cannot add it. `updatedAt` is left
 * alone on purpose; the order of "recently changed" lists must not shuffle.
 *
 * Idempotent: only documents without a `publicCode` are touched, and the write
 * is guarded on that again, so a re-run or a concurrent run assigns nothing twice.
 * Prints counts only.
 *
 * Dry run is the default and writes nothing. Review the counts, then:
 *   docker exec -e MONGODB_URI="$MONGODB_URI" <backend-container> \
 *     node scripts/backfill-public-codes.js            # dry run
 *   docker exec -e MONGODB_URI="$MONGODB_URI" <backend-container> \
 *     node scripts/backfill-public-codes.js --apply
 
 *
 * Connects through lib/database, which refuses a standalone mongod (replica set
 * required, as in production), read-only audit included.
 */
const { connectDB, closeDB } = require('../lib/database');
const { products, combos } = require('../data');

const REPOSITORIES = [
	{ key: 'products', repo: products },
	{ key: 'combos', repo: combos }
];

async function backfillRepository(repo, apply) {
	const counts = { total: await repo.count(), missing: 0, assigned: 0 };

	for (const row of await repo.listWithoutPublicCode()) {
		counts.missing += 1;
		if (!apply) continue;
		if (await repo.assignMissingPublicCode(row)) counts.assigned += 1;
	}
	return counts;
}

/**
 * @param {{apply?: boolean}} [options]
 * @returns {Promise<{products: {total: number, missing: number, assigned: number}, combos: {total: number, missing: number, assigned: number}}>}
 */
async function run({ apply = false } = {}) {
	const result = {};
	for (const { key, repo } of REPOSITORIES) {
		result[key] = await backfillRepository(repo, apply);
	}
	return result;
}

async function main() {
	require('dotenv').config({ quiet: true });
	const apply = process.argv.includes('--apply');

	await connectDB();
	// The unique index must exist before writing, or uniqueness rests on chance.
	if (apply) await Promise.all(REPOSITORIES.map(({ repo }) => repo.ensureIndexes()));

	try {
		const result = await run({ apply });
		console.log(`--- public code backfill (${apply ? 'APPLY' : 'dry run'}) ---`);
		for (const { key } of REPOSITORIES) {
			console.log(`${key}: total ${result[key].total}, without a code ${result[key].missing}${apply ? `, assigned ${result[key].assigned}` : ''}`);
		}
		if (!apply) {
			console.log('\nDry run only — nothing written. Re-run with --apply to assign the codes.');
		}
	} finally {
		await closeDB();
	}
}

module.exports = { run };

if (require.main === module) {
	main().catch((error) => {
		console.error('backfill failed:', error.message);
		process.exit(1);
	});
}
