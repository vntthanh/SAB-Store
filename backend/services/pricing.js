/**
 * Server-side order pricing.
 *
 * Every monetary figure an order is stored with must come from this module.
 * Prices, totals and combo savings sent by a client are advisory at best and
 * hostile at worst, so they are read from the database instead of trusted.
 */

const mongoose = require('mongoose');
const Product = require('../models/Product');
const Combo = require('../models/Combo');
const ComboService = require('./ComboService');
const { ERROR_CODES } = require('../constants/errorCodes');

/**
 * Error thrown for every rejected pricing request.
 *
 * Always maps to HTTP 400: each code describes a cart the caller could have
 * validated before sending, never a server fault.
 */
class PricingError extends Error {
	/**
	 * @param {'EMPTY_CART'|'PRODUCT_UNAVAILABLE'|'PRODUCT_CHANNEL_MISMATCH'|'INVALID_QUANTITY'} code
	 * @param {{missingIds?: string[], productId?: string, productNames?: string[], channel?: string}} [details]
	 */
	constructor(code, details = {}) {
		super(code);
		this.name = 'PricingError';
		this.code = code;
		this.httpStatus = 400;
		this.details = details;
	}
}

const CHANNEL_LABELS = { online: 'online', offline: 'tại quầy' };

const PRICING_ERROR_MESSAGES = {
	EMPTY_CART: 'Danh sách sản phẩm không hợp lệ',
	PRODUCT_UNAVAILABLE: 'Một hoặc nhiều sản phẩm không tồn tại hoặc không khả dụng',
	INVALID_QUANTITY: 'Số lượng sản phẩm không hợp lệ',
};

/** Vietnamese, client-facing message for a PricingError. */
function describePricingError(error) {
	if (error.code === ERROR_CODES.PRODUCT_CHANNEL_MISMATCH) {
		const names = (error.details.productNames || []).join(', ');
		return `Sản phẩm không bán ${CHANNEL_LABELS[error.details.channel] || 'ở kênh này'}: ${names}`;
	}
	return PRICING_ERROR_MESSAGES[error.code] || 'Không thể tính giá đơn hàng';
}

/**
 * Load the products with `ids` that can be sold on `channel`, or reject.
 *
 * A product that exists and is switched on but belongs to the other channel is
 * reported as PRODUCT_CHANNEL_MISMATCH with its name, so a cashier or customer
 * learns why; a missing or switched-off one stays PRODUCT_UNAVAILABLE. When a
 * cart has both kinds, UNAVAILABLE wins because the cart is unfixable by
 * switching channel.
 *
 * @param {string[]} ids canonical (lowercase) ObjectId strings
 * @param {'online'|'offline'} channel
 * @param {import('mongoose').ClientSession|null} [session]
 * @returns {Promise<Map<string, import('mongoose').Document>>} keyed by `_id.toString()`
 * @throws {TypeError} channel missing or unknown (a programming error, not a bad cart)
 * @throws {PricingError}
 */
async function loadSellableProducts(ids, channel, session = null) {
	let query = Product.findSellable(channel, { _id: { $in: ids } });
	if (session) query = query.session(session);
	const products = await query;

	const productMap = new Map(products.map((product) => [product._id.toString(), product]));
	const missingIds = ids.filter((id) => !productMap.has(id));
	if (missingIds.length === 0) return productMap;

	let otherChannelQuery = Product.find({ _id: { $in: missingIds }, available: true }).select('name').lean();
	if (session) otherChannelQuery = otherChannelQuery.session(session);
	const otherChannel = await otherChannelQuery;

	if (otherChannel.length === missingIds.length) {
		throw new PricingError(ERROR_CODES.PRODUCT_CHANNEL_MISMATCH, {
			missingIds,
			productNames: otherChannel.map((product) => product.name),
			channel,
		});
	}
	throw new PricingError('PRODUCT_UNAVAILABLE', { missingIds });
}

/**
 * Compute an order's totals from the database, ignoring any client-supplied price.
 *
 * Availability is a single rule, `Product.findSellable(channel)`: a product
 * counts only when `available` is true and its `salesChannel` allows `channel`.
 * There is deliberately no flag to relax it — it would let a direct sale sell
 * `available: false` stock. `channel` has no default: a caller that forgets it
 * would silently sell on the wrong channel, so it throws instead.
 *
 * Duplicate `productId` lines are merged rather than rejected, because a cart
 * legitimately reaches this point with the same product added twice.
 *
 * @param {Array<{productId: string, quantity: number}>} items
 *        Cart lines. Lines sharing a productId are summed.
 * @param {object} [opts]
 * @param {'online'|'offline'} opts.channel Required. Where the order is placed.
 * @param {import('mongoose').ClientSession|null} [opts.session=null]
 *        Pass when called inside a transaction; every query issued here must
 *        then run with `.session(session)`. Null runs outside a transaction
 *        (read-only previews).
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
 * @throws {TypeError} `opts.channel` is missing or not 'online'/'offline'.
 * @throws {PricingError} An empty cart throws EMPTY_CART; it never returns a
 *        zero total, which would otherwise be indistinguishable from a free order.
 */
async function computeOrderPricing(items, opts = {}) {
	const session = opts.session || null;
	const channel = opts.channel;
	// Fail before any query: this is the check that makes a forgotten channel
	// impossible to ship, and it must not depend on the cart being valid.
	Product.sellableQuery(channel);

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

	// Query 1/2 — products, filtered by the single sellable-on-channel rule.
	const productMap = await loadSellableProducts(ids, channel, session);

	let cartLines = ids.map((id) => ({
		productId: id,
		product: productMap.get(id),
		quantity: qtyByProductId.get(id),
	}));

	// Query 2/2 — combos that apply on this channel, loaded once and reused for
	// the single combo application below.
	let comboQuery = Combo.findSellable(channel);
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

module.exports = { computeOrderPricing, loadSellableProducts, describePricingError, PricingError };
