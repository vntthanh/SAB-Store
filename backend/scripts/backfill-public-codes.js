/**
 * Give every product and combo created before public codes existed its
 * `publicCode` + `slug`, so its share link works.
 *
 * Writes through the raw driver (see `assignMissingPublicCode`): the field is
 * immutable, so saving a Mongoose document cannot add it. `updatedAt` is left
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
 */
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Combo = require('../models/Combo');
const { assignMissingPublicCode } = require('../utils/public-code');

const MODELS = [
	{ key: 'products', Model: Product },
	{ key: 'combos', Model: Combo }
];

async function backfillModel(Model, apply) {
	const counts = { total: 0, missing: 0, assigned: 0 };
	counts.total = await Model.countDocuments({});

	// Raw collection filter: Mongoose would not apply defaults to it anyway, and
	// `$exists:false` is exactly the state the write below guards on.
	// Read up front: writing while a cursor over the same filter is open can skip documents.
	const pending = await Model.collection.find({ publicCode: { $exists: false } }, { projection: { _id: 1, name: 1 } }).toArray();
	for (const doc of pending) {
		counts.missing += 1;
		if (!apply) continue;
		if (await assignMissingPublicCode(Model, doc)) counts.assigned += 1;
	}
	return counts;
}

/**
 * @param {{apply?: boolean}} [options]
 * @returns {Promise<{products: {total: number, missing: number, assigned: number}, combos: {total: number, missing: number, assigned: number}}>}
 */
async function run({ apply = false } = {}) {
	const result = {};
	for (const { key, Model } of MODELS) {
		result[key] = await backfillModel(Model, apply);
	}
	return result;
}

async function main() {
	require('dotenv').config({ quiet: true });
	const apply = process.argv.includes('--apply');

	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI is required');
	await mongoose.connect(uri);
	// The unique index must exist before writing, or uniqueness rests on chance.
	if (apply) await Promise.all([Product.init(), Combo.init()]);

	try {
		const result = await run({ apply });
		console.log(`--- public code backfill (${apply ? 'APPLY' : 'dry run'}) ---`);
		for (const { key } of MODELS) {
			console.log(`${key}: total ${result[key].total}, without a code ${result[key].missing}${apply ? `, assigned ${result[key].assigned}` : ''}`);
		}
		if (!apply) {
			console.log('\nDry run only — nothing written. Re-run with --apply to assign the codes.');
		}
	} finally {
		await mongoose.disconnect();
	}
}

module.exports = { run };

if (require.main === module) {
	main().catch((error) => {
		console.error('backfill failed:', error.message);
		process.exit(1);
	});
}
