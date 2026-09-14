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
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Order = require('../models/Order');
const Product = require('../models/Product');
const Combo = require('../models/Combo');

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

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI is required');

	await mongoose.connect(uri);

	const orders = await Order.find({ 'comboInfo.comboId': { $ne: null } })
		.select('orderCode status totalAmount items comboInfo createdAt')
		.lean();

	const combos = await Combo.find({}).lean();
	const comboById = new Map(combos.map((c) => [String(c._id), c]));

	const products = await Product.find({}).select('category').lean();
	const categoryByProduct = new Map(products.map((p) => [String(p._id), p.category]));

	const suspect = [];
	const unverifiable = [];

	for (const order of orders) {
		const combo = comboById.get(String(order.comboInfo.comboId));
		if (!combo) {
			// The combo was deleted since; its requirements cannot be reconstructed.
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

		if (maxApplications(combo, quantityByCategory) < 1) {
			suspect.push({
				orderCode: order.orderCode,
				status: order.status,
				storedTotal: order.totalAmount,
				claimedSavings: order.comboInfo.savings || 0,
				comboName: combo.name,
				createdAt: order.createdAt,
			});
		}
	}

	const totalOrders = await Order.countDocuments({});
	const understated = suspect.reduce((sum, o) => sum + (o.claimedSavings || 0), 0);

	console.log('--- combo pricing audit (read-only) ---');
	console.log('orders total:              ', totalOrders);
	console.log('orders with a combo:       ', orders.length);
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
	await mongoose.disconnect();
}

main().catch((error) => {
	console.error('audit failed:', error.message);
	process.exit(1);
});
