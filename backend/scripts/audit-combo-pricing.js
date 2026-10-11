/**
 * READ-ONLY audit: which stored orders were charged a combo they did not qualify for?
 *
 * Background. Combo.getMaxApplications() seeded its running minimum to 0 and
 * guarded with `if (maxApplications === 0)`, which cannot tell "not yet
 * initialised" from "genuinely zero". So when the FIRST category requirement
 * was unmet (0 applications) but a LATER one was satisfied, the zero was
 * overwritten instead of taking the minimum, and the combo applied anyway.
 * The checkout page sent `useOptimalPricing` whenever it displayed savings and
 * the server trusted that flag, so an affected order was stored with a total
 * lower than the customer should have paid.
 *
 * This script only reads. It issues no update, insert or delete, and prints no
 * personal data — order codes only, never names or student IDs.
 *
 * Run on the server, where MONGODB_URI is already set:
 *   docker exec -e MONGODB_URI="$MONGODB_URI" sab-store-backend-1 \
 *     node scripts/audit-combo-pricing.js
 
 *
 * Connects through lib/database, which refuses a standalone mongod (replica set
 * required, as in production), read-only audit included.
 */
require('dotenv').config({ quiet: true });
const { connectDB, closeDB } = require('../lib/database');
const { orders, products, combos: comboRepo } = require('../data');

// The corrected rule: every requirement must be satisfiable, and the number of
// applications is the minimum across all of them.
function maxApplications(combo, quantityByCategory) {
	let applications = Infinity;
	for (const requirement of combo.categoryRequirements) {
		const available = quantityByCategory[requirement.category] || 0;
		applications = Math.min(applications, Math.floor(available / requirement.quantity));
	}
	return Number.isFinite(applications) ? applications : 0;
}

// Orders store comboInfo in two shapes: a single combo ({ comboId, ... }, older
// online orders) or several ({ combos: [{ comboId, ... }] }, counter orders and
// everything priced by the current engine).
function comboRefsOf(comboInfo) {
	if (Array.isArray(comboInfo.combos)) return comboInfo.combos;
	return comboInfo.comboId ? [comboInfo] : [];
}

async function main() {
	await connectDB();

	const withCombo = await orders.listWithCombo();
	const comboById = new Map((await comboRepo.list()).map((c) => [String(c._id), c]));
	const categoryByProduct = new Map((await products.listCategoryById()).map((p) => [String(p._id), p.category]));

	const suspect = [];
	const unverifiable = [];

	for (const order of withCombo) {
		const refs = comboRefsOf(order.comboInfo);
		const applied = refs.map((ref) => comboById.get(String(ref.comboId)));
		if (refs.length === 0 || applied.some((combo) => !combo)) {
			// A combo was deleted since; its requirements cannot be reconstructed.
			unverifiable.push({ orderCode: order.orderCode, reason: 'combo no longer exists' });
			continue;
		}

		const quantityByCategory = {};
		let missingCategory = false;
		for (const item of order.items) {
			const category = categoryByProduct.get(String(item.productId));
			if (!category) { missingCategory = true; break; }
			quantityByCategory[category] = (quantityByCategory[category] || 0) + item.quantity;
		}

		if (missingCategory) {
			unverifiable.push({ orderCode: order.orderCode, reason: 'product no longer exists' });
			continue;
		}

		// Each combo applied must be satisfiable by the order's items on its own;
		// this is necessary, not sufficient, when several combos share items.
		const unqualified = applied.filter((combo) => maxApplications(combo, quantityByCategory) < 1);
		if (unqualified.length > 0) {
			suspect.push({
				orderCode: order.orderCode,
				status: order.status,
				storedTotal: order.totalAmount,
				claimedSavings: order.comboInfo.savings || 0,
				comboName: unqualified.map((combo) => combo.name).join(', '),
				createdAt: order.createdAt,
			});
		}
	}

	const totalOrders = await orders.count();
	const understated = suspect.reduce((sum, o) => sum + (o.claimedSavings || 0), 0);

	console.log('--- combo pricing audit (read-only) ---');
	console.log('orders total:              ', totalOrders);
	console.log('orders with a combo:       ', withCombo.length);
	console.log('combo did NOT qualify:     ', suspect.length);
	console.log('could not verify:          ', unverifiable.length);
	console.log('savings granted on those:  ', understated.toLocaleString('vi-VN'), 'VND');

	if (suspect.length) {
		console.log('\naffected orders:');
		for (const o of suspect) {
			console.log(
				`  ${o.orderCode}  ${String(o.status).padEnd(10)}` +
				`  stored=${o.storedTotal}  savings=${o.claimedSavings}  combo="${o.comboName}"`
			);
		}
	}

	if (unverifiable.length) {
		console.log('\nnot verifiable (referenced data deleted):');
		for (const o of unverifiable) console.log(`  ${o.orderCode}  ${o.reason}`);
	}

	console.log('\nNo data was modified.');
	await closeDB();
}

if (require.main === module) {
	main().catch((error) => {
		console.error('audit failed:', error.message);
		process.exit(1);
	});
}

module.exports = { comboRefsOf };
