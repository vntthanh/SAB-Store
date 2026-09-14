/**
 * Backfill `Order.stockDeducted` for the 430 production orders that predate
 * this field (added this phase). DOES NOT RUN AUTOMATICALLY — the lead runs
 * this by hand after reviewing the rule below and the dry-run output.
 *
 * The rule: `stockDeducted = order.isDirectSale === true`.
 *
 * Why that rule is correct for every historical order, derived from reading
 * the route code (not from querying the real database, which this worktree
 * has no access to):
 *
 *   - Web orders (`isDirectSale: false`, created by routes/orders.js) never
 *     issued a single `stockQuantity` write anywhere in that route, before
 *     or after this phase (Q1 — an explicit, unchanged business decision).
 *     -> stockDeducted must be false.
 *
 *   - Direct-sale orders created through backend/routes/seller.js
 *     POST /orders/direct DID deduct stock in the pre-this-phase code
 *     (`product.stockQuantity -= item.quantity; await product.save();`, run
 *     for every line before the order document was even written).
 *     -> stockDeducted must be true.
 *
 *   - Direct-sale orders created through backend/routes/admin/orders.js
 *     POST /direct: this route was broken on every single call before this
 *     phase — `createdBy: req.admin.username` (a String) was assigned to a
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
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');

async function main() {
	const apply = process.argv.includes('--apply');

	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI is required');

	await mongoose.connect(uri);

	const missingFilter = { stockDeducted: { $exists: false } };
	const missing = await Order.countDocuments(missingFilter);
	const directCount = await Order.countDocuments({ ...missingFilter, isDirectSale: true });
	const webCount = await Order.countDocuments({ ...missingFilter, isDirectSale: { $ne: true } });

	console.log('--- stockDeducted backfill (rule: stockDeducted = isDirectSale) ---');
	console.log('orders missing stockDeducted:                  ', missing);
	console.log('  -> would set stockDeducted=true  (isDirectSale=true):  ', directCount);
	console.log('  -> would set stockDeducted=false (isDirectSale!=true): ', webCount);

	if (!apply) {
		console.log('\nDry run only — no documents modified. Re-run with --apply to write.');
		await mongoose.disconnect();
		return;
	}

	const trueResult = await Order.updateMany(
		{ ...missingFilter, isDirectSale: true },
		{ $set: { stockDeducted: true } }
	);
	const falseResult = await Order.updateMany(
		{ ...missingFilter, isDirectSale: { $ne: true } },
		{ $set: { stockDeducted: false } }
	);

	console.log('\nApplied.');
	console.log('  stockDeducted=true set on  ', trueResult.modifiedCount, 'orders');
	console.log('  stockDeducted=false set on ', falseResult.modifiedCount, 'orders');

	await mongoose.disconnect();
}

main().catch((error) => {
	console.error('backfill failed:', error.message);
	process.exit(1);
});
