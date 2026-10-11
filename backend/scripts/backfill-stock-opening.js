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
 
 *
 * Connects through lib/database, which refuses a standalone mongod (replica set
 * required, as in production), read-only audit included.
 */
const { connectDB, closeDB } = require('../lib/database');
const { products, stockLedger, withTransaction } = require('../data');
const { recordAppliedOpening } = require('../services/stock-ledger');

const CREATED_BY = 'backfill-stock-opening';

/**
 * @param {{apply?: boolean}} [options]
 * @returns {Promise<{products: number, alreadyBaselined: number, toCreate: number, created: number}>}
 */
async function backfillOpening({ apply = false } = {}) {
	const counts = { products: 0, alreadyBaselined: 0, toCreate: 0, created: 0 };

	for (const productId of await products.listIds()) {
		counts.products += 1;

		if (await stockLedger.findMovementByKey(`opening:${productId}`)) {
			counts.alreadyBaselined += 1;
			continue;
		}
		counts.toCreate += 1;
		if (!apply) continue;

		const created = await withTransaction(async (tx) => {
			// Read inside the transaction: the stock and the sum must be one snapshot.
			const basis = await stockLedger.readOpeningBasis(productId, tx);
			if (!basis) return false;
			await recordAppliedOpening({
				productId,
				quantity: basis.stockQuantity - basis.appliedSum,
				stockAfter: basis.stockQuantity,
				createdBy: CREATED_BY,
				reason: 'Baseline of existing stock'
			}, { tx });
			return true;
		});
		if (created) counts.created += 1;
	}
	return counts;
}

async function main() {
	require('dotenv').config({ quiet: true });
	const apply = process.argv.includes('--apply');

	await connectDB();

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
		await closeDB();
	}
}

module.exports = { backfillOpening };

if (require.main === module) {
	main().catch((error) => {
		console.error('backfill failed:', error.message);
		process.exit(1);
	});
}
