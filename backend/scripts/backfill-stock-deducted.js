/**
 * Backfill `Order.stockDeducted` for orders created before the field existed.
 * DOES NOT RUN AUTOMATICALLY — run it by hand after reviewing the rule below
 * and the dry-run output.
 *
 * The rule: `stockDeducted = order.isDirectSale === true`.
 *
 * Why that rule is correct for every order older than the field, derived
 * from reading the route code of that time:
 *
 *   - Web orders (`isDirectSale: false`, created by routes/orders.js) never
 *     wrote `stockQuantity` back then; stock is not deducted retroactively.
 *     -> stockDeducted must be false.
 *
 *   - Direct-sale orders created through backend/routes/seller.js
 *     POST /orders/direct DID deduct stock before the ledger
 *     (`product.stockQuantity -= item.quantity; await product.save();`, run
 *     for every line before the order document was even written).
 *     -> stockDeducted must be true.
 *
 *   - Direct-sale orders created through backend/routes/admin/orders.js
 *     POST /direct: this route failed on every call back then — `createdBy: req.admin.username` (a String) was assigned to a
 *     schema path typed `ObjectId`, which Mongoose rejects with a CastError
 *     on `order.save()`. Since the document is only written by that final
 *     `.save()` call, and it always threw, no order was ever actually
 *     persisted by this route. There is therefore no historical order that
 *     both (a) has `isDirectSale: true` and (b) skipped the stock-deducting
 *     branch — every persisted `isDirectSale: true` order went through
 *     seller.js, which did deduct stock.
 *
 * This last point is the one assumption worth an independent sanity check
 * before running with `--apply`; the dry-run counts below don't prove it by
 * themselves. If the counts look surprising, stop and investigate rather
 * than applying.
 *
 * Idempotent: only touches documents where `stockDeducted` does not exist
 * yet, so re-running after a partial or repeat run is a no-op for anything
 * already set.
 *
 * Usage (dry run is the default — no flag needed):
 *   docker exec -e MONGODB_URI="$MONGODB_URI" sab-store-backend-1 \
 *     node scripts/backfill-stock-deducted.js
 *
 * Apply for real only after reviewing the dry-run output:
 *   docker exec -e MONGODB_URI="$MONGODB_URI" sab-store-backend-1 \
 *     node scripts/backfill-stock-deducted.js --apply
 
 *
 * Connects through lib/database, which refuses a standalone mongod (replica set
 * required, as in production), read-only audit included.
 */
require('dotenv').config({ quiet: true });
const { connectDB, closeDB } = require('../lib/database');
const { orders } = require('../data');

async function main() {
	const apply = process.argv.includes('--apply');

	await connectDB();

	try {
		const { missing, direct, web } = await orders.countMissingStockDeducted();

		console.log('--- stockDeducted backfill (rule: stockDeducted = isDirectSale) ---');
		console.log('orders missing stockDeducted:                  ', missing);
		console.log('  -> would set stockDeducted=true  (isDirectSale=true):  ', direct);
		console.log('  -> would set stockDeducted=false (isDirectSale!=true): ', web);

		if (!apply) {
			console.log('\nDry run only — no documents modified. Re-run with --apply to write.');
			return;
		}

		const { markedDeducted, markedNotDeducted } = await orders.backfillStockDeducted();

		console.log('\nApplied.');
		console.log('  stockDeducted=true set on  ', markedDeducted, 'orders');
		console.log('  stockDeducted=false set on ', markedNotDeducted, 'orders');
	} finally {
		await closeDB();
	}
}

main().catch((error) => {
	console.error('backfill failed:', error.message);
	process.exit(1);
});
