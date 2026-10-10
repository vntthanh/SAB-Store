/**
 * Baseline the stock ledger for products that existed before it did: record one
 * applied `opening` movement per product so that, from then on, the sum of a
 * product's applied movements equals its `stockQuantity` and `reconcile` has
 * nothing to report.
 *
 * The opening delta is `stockQuantity - (sum of applied movements)`. Run before
 * any movement exists that is simply the current stock; if movements were
 * already applied it still lands the ledger exactly on the cache instead of
 * double-counting them. Run it with no stock-changing traffic: a sale landing
 * between the read and the insert would leave the product off by that sale, and
 * `GET /api/admin/stock/reconcile` shows it if so.
 *
 * Idempotent: the key `opening:<productId>` is unique, so a product that already
 * has an opening (from this script or from being created through the admin API)
 * is skipped. Prints counts only.
 *
 * Dry run is the default and writes nothing. Review the counts, then:
 *   docker exec -e MONGODB_URI="$MONGODB_URI" <backend-container> \
 *     node scripts/backfill-stock-opening.js            # dry run
 *   docker exec -e MONGODB_URI="$MONGODB_URI" <backend-container> \
 *     node scripts/backfill-stock-opening.js --apply
 */
const mongoose = require('mongoose');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const { recordAppliedOpening } = require('../services/stock-ledger');

const CREATED_BY = 'backfill-stock-opening';

async function appliedSum(productId, session) {
	const [row] = await StockMovement.aggregate([
		{ $match: { productId, status: 'applied' } },
		{ $group: { _id: null, sum: { $sum: '$delta' } } }
	]).session(session);
	return row ? row.sum : 0;
}

/**
 * @param {{apply?: boolean}} [options]
 * @returns {Promise<{products: number, alreadyBaselined: number, toCreate: number, created: number}>}
 */
async function backfillOpening({ apply = false } = {}) {
	const counts = { products: 0, alreadyBaselined: 0, toCreate: 0, created: 0 };

	for await (const product of Product.find({}).select('_id').lean().cursor()) {
		counts.products += 1;

		if (await StockMovement.exists({ idempotencyKey: `opening:${product._id}` })) {
			counts.alreadyBaselined += 1;
			continue;
		}
		counts.toCreate += 1;
		if (!apply) continue;

		const session = await mongoose.startSession();
		let created = false;
		try {
			await session.withTransaction(async () => {
				created = false;
				// Read inside the transaction: the stock and the sum must be one snapshot.
				const fresh = await Product.findById(product._id).select('stockQuantity').session(session).lean();
				if (!fresh) return;
				const cached = fresh.stockQuantity || 0;
				await recordAppliedOpening({
					productId: product._id,
					quantity: cached - await appliedSum(product._id, session),
					stockAfter: cached,
					createdBy: CREATED_BY,
					reason: 'Baseline of existing stock'
				}, { session });
				created = true;
			});
		} finally {
			await session.endSession();
		}
		if (created) counts.created += 1;
	}
	return counts;
}

async function main() {
	require('dotenv').config({ quiet: true });
	const apply = process.argv.includes('--apply');

	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI is required');
	await mongoose.connect(uri);

	try {
		const counts = await backfillOpening({ apply });
		console.log(`--- stock opening backfill (${apply ? 'APPLY' : 'dry run'}) ---`);
		console.log('products:                    ', counts.products);
		console.log('already have an opening:     ', counts.alreadyBaselined);
		console.log('without an opening:          ', counts.toCreate);
		if (apply) {
			console.log('openings recorded:           ', counts.created);
		} else {
			console.log('\nDry run only — nothing written. Re-run with --apply to record the openings.');
		}
	} finally {
		await mongoose.disconnect();
	}
}

module.exports = { backfillOpening };

if (require.main === module) {
	main().catch((error) => {
		console.error('backfill failed:', error.message);
		process.exit(1);
	});
}
