/**
 * Server-side order pricing.
 *
 * Every monetary figure an order is stored with must come from this module.
 * Prices, totals and combo savings sent by a client are advisory at best and
 * hostile at worst, so they are read from the database instead of trusted.
 *
 * Phase 00 ships the contract only. Phase 05 supplies the implementation;
 * Phase 06 calls it from inside the stock flow. The stub throws rather than
 * returning a plausible-looking zero so that a consumer wired up before the
 * implementation lands fails loudly instead of silently writing free orders.
 */

const mongoose = require('mongoose');
const Product = require('../models/Product');
const Combo = require('../models/Combo');
const ComboService = require('./ComboService');

/**
 * Error thrown for every rejected pricing request.
 *
 * Always maps to HTTP 400: each code describes a cart the caller could have
 * validated before sending, never a server fault.
 */
class PricingError extends Error {
	/**
	 * @param {'EMPTY_CART'|'PRODUCT_UNAVAILABLE'|'INVALID_QUANTITY'} code
	 * @param {{missingIds?: string[], productId?: string}} [details]
	 */
	constructor(code, details = {}) {
		super(code);
		this.name = 'PricingError';
		this.code = code;
		this.httpStatus = 400;
		this.details = details;
	}
}

/**
 * Compute an order's totals from the database, ignoring any client-supplied price.
 *
 * Availability is a single rule: a product counts only when `isActive` AND
 * `available` are both true, matching `Product.findAvailable()`. There is
 * deliberately no flag to relax it — an earlier draft of this contract offered
 * one and would have let direct sales sell `available: false` stock.
 *
 * Duplicate `productId` lines are merged rather than rejected, because a cart
 * legitimately reaches this point with the same product added twice.
 *
 * @param {Array<{productId: string, quantity: number}>} items
 *        Cart lines. Lines sharing a productId are summed.
 * @param {object} [opts]
 * @param {import('mongoose').ClientSession|null} [opts.session=null]
 *        Pass when called inside a transaction; every query issued here must
 *        then run with `.session(session)`. Null is a supported mode, not a
 *        degraded one — the deployment has no replica set (see plan AD-4).
 * @returns {Promise<{
 *   totalAmount: number,
 *   orderItems: Array<{
 *     productId: import('mongoose').Types.ObjectId,
 *     productName: string,
 *     price: number,
 *     quantity: number,
 *     fromCombo: boolean,
 *     comboId: import('mongoose').Types.ObjectId|null,
 *     comboName: string|null
 *   }>,
 *   comboInfo: {
 *     comboId: import('mongoose').Types.ObjectId,
 *     comboName: string,
 *     savings: number,
 *     originalTotal: number,
 *     finalTotal: number
 *   }|null,
 *   products: Map<string, import('mongoose').Document>
 * }>}
 *        `orderItems[].productId` is an ObjectId, not a string, so the result
 *        can be written to an Order without re-casting.
 *        `products` is keyed by `productId.toString()` so callers can reuse the
 *        already-loaded documents instead of querying again.
 * @throws {PricingError} An empty cart throws EMPTY_CART; it never returns a
 *        zero total, which would otherwise be indistinguishable from a free order.
 */
async function computeOrderPricing(items, opts = {}) {
	const session = opts.session || null;

	if (!Array.isArray(items) || items.length === 0) {
		throw new PricingError('EMPTY_CART');
	}

	// Merge duplicate productId lines and normalize ObjectId casing (an
	// uppercase-hex id passes isMongoId()/$in but would fail a later strict
	// string comparison against the lowercase form Mongo returns).
	const qtyByProductId = new Map();
	for (const item of items) {
		const rawId = item && item.productId;
		if (!rawId || !mongoose.Types.ObjectId.isValid(rawId)) {
			throw new PricingError('PRODUCT_UNAVAILABLE', { missingIds: [String(rawId)] });
		}
		const quantity = Number(item.quantity);
		if (!Number.isInteger(quantity) || quantity <= 0) {
			throw new PricingError('INVALID_QUANTITY', { productId: String(rawId) });
		}
		const key = new mongoose.Types.ObjectId(rawId).toString();
		qtyByProductId.set(key, (qtyByProductId.get(key) || 0) + quantity);
	}

	if (qtyByProductId.size === 0) {
		throw new PricingError('EMPTY_CART');
	}

	const ids = [...qtyByProductId.keys()];

	// Query 1/2 — products, filtered by the single availability rule
	// (isActive AND available), matching Product.findAvailable(). There is
	// deliberately no flag to relax this: it would let a caller (e.g. a
	// direct sale) sell stock marked `available: false`.
	let productQuery = Product.find({ _id: { $in: ids }, isActive: true, available: true });
	if (session) productQuery = productQuery.session(session);
	const products = await productQuery;

	const productMap = new Map();
	for (const product of products) {
		productMap.set(product._id.toString(), product);
	}

	const missingIds = ids.filter((id) => !productMap.has(id));
	if (missingIds.length > 0) {
		throw new PricingError('PRODUCT_UNAVAILABLE', { missingIds });
	}

	let cartLines = ids.map((id) => ({
		productId: id,
		product: productMap.get(id),
		quantity: qtyByProductId.get(id),
	}));

	// Query 2/2 — active combos, loaded once and reused for the single combo
	// application below. The pre-fix code (ComboService.calculateOptimalPricing)
	// re-queried Combo.findActive() on every loop iteration.
	let comboQuery = Combo.findActive();
	if (session) comboQuery = comboQuery.session(session);
	const activeCombos = await comboQuery;

	let comboInfo = null;
	const orderItems = [];

	if (activeCombos.length > 0) {
		// findOptimalCombination sorts applicable combos (maxApplications > 0,
		// per the fixed Combo.getMaxApplications) by savings then priority, so
		// [0] is the single best combo for this cart — computeOrderPricing
		// applies at most one, matching the singular comboInfo contract below.
		const optimalCombos = await Combo.findOptimalCombination(cartLines, activeCombos);

		if (optimalCombos.length > 0 && optimalCombos[0].totalSavings > 0) {
			const best = optimalCombos[0];
			const application = ComboService.applyComboToProducts(best, cartLines);

			if (application.applicationsUsed > 0) {
				const originalTotal = application.itemsUsed.reduce((sum, i) => sum + i.subtotal, 0);
				const finalTotal = application.applicationsUsed * best.combo.price;

				for (const used of application.itemsUsed) {
					orderItems.push({
						productId: productMap.get(used.productId)._id,
						productName: used.productName,
						price: used.price,
						quantity: used.quantity,
						fromCombo: true,
						comboId: best.combo._id,
						comboName: best.combo.name,
					});
				}

				comboInfo = {
					comboId: best.combo._id,
					comboName: best.combo.name,
					savings: application.savings,
					originalTotal,
					finalTotal,
				};

				cartLines = application.remainingProducts;
			}
		}
	}

	for (const line of cartLines) {
		if (line.quantity <= 0) continue;
		orderItems.push({
			productId: line.product._id,
			productName: line.product.name,
			price: line.product.price,
			quantity: line.quantity,
			fromCombo: false,
			comboId: null,
			comboName: null,
		});
	}

	// totalAmount is NOT Σ(item.price × item.quantity) over orderItems: combo
	// lines keep their original per-unit price for display/reference (as the
	// pre-fix orders.js did), so summing that would double the combo's own
	// discount away. The combo's contribution is its discounted finalTotal;
	// only individual (non-combo) lines are priced at price × quantity.
	const individualTotal = orderItems
		.filter((item) => !item.fromCombo)
		.reduce((sum, item) => sum + item.price * item.quantity, 0);
	const totalAmount = (comboInfo ? comboInfo.finalTotal : 0) + individualTotal;

	return { totalAmount, orderItems, comboInfo, products: productMap };
}

module.exports = { computeOrderPricing, PricingError };
