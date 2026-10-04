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
const { solve, mergeRequirements, StateBudgetExceededError } = require('./combo-optimizer');
const { ERROR_CODES } = require('../constants/errorCodes');

/**
 * Error thrown for every rejected pricing request.
 *
 * HTTP 400 for every code except PRICE_CHANGED (409): each 400 describes a cart
 * the caller could have validated before sending, never a server fault.
 */
class PricingError extends Error {
	/**
	 * @param {'EMPTY_CART'|'PRODUCT_UNAVAILABLE'|'PRODUCT_CHANNEL_MISMATCH'|'INVALID_QUANTITY'|'CART_TOO_MANY_UNITS'|'CART_TOO_COMPLEX'|'PRICE_CHANGED'} code
	 * @param {{missingIds?: string[], productId?: string, productNames?: string[], channel?: string,
	 *          expectedTotal?: number, totalAmount?: number}} [details]
	 */
	constructor(code, details = {}) {
		super(code);
		this.name = 'PricingError';
		this.code = code;
		this.httpStatus = code === ERROR_CODES.PRICE_CHANGED ? 409 : 400;
		this.details = details;
	}
}

// Only what the engine reads. Selecting fields and returning plain objects
// (`lean`) skips hydrating full Mongoose documents. The combo search itself
// stays in Node: a dynamic program as an aggregation pipeline would run on the
// small mongod (512 MB, 0.25 GB cache) and be slower than this in-memory one.
const PRODUCT_FIELDS = '_id name price category minOrderQuantity maxOrderQuantity available salesChannel';
const COMBO_FIELDS = '_id name price categoryRequirements priority salesChannel isActive';

const CHANNEL_LABELS = { online: 'online', offline: 'tại quầy' };

// Largest order, in units, the engine prices. It bounds the combo search and
// the stock work a single order can trigger.
const MAX_UNITS_PER_ORDER = 200;

const PRICING_ERROR_MESSAGES = {
	[ERROR_CODES.CART_TOO_MANY_UNITS]: `Mỗi đơn hàng tối đa ${MAX_UNITS_PER_ORDER} sản phẩm`,
	[ERROR_CODES.CART_TOO_COMPLEX]: 'Giỏ hàng quá phức tạp để tính giá, vui lòng tách thành nhiều đơn',
	[ERROR_CODES.PRICE_CHANGED]: 'Giá vừa thay đổi, vui lòng xem lại giỏ hàng',
	EMPTY_CART: 'Danh sách sản phẩm không hợp lệ',
	PRODUCT_UNAVAILABLE: 'Một hoặc nhiều sản phẩm không tồn tại hoặc không khả dụng',
	INVALID_QUANTITY: 'Số lượng sản phẩm không hợp lệ',
};

/** JSON body every route returns for a PricingError, so clients can branch on `code`. */
function pricingErrorBody(error) {
	return {
		success: false,
		code: error.code,
		message: describePricingError(error),
		...(Object.keys(error.details || {}).length > 0 && { details: error.details }),
	};
}

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
 * @returns {Promise<Map<string, object>>} lean product objects keyed by `_id.toString()`
 * @throws {TypeError} channel missing or unknown (a programming error, not a bad cart)
 * @throws {PricingError}
 */
async function loadSellableProducts(ids, channel, session = null) {
	let query = Product.findSellable(channel, { _id: { $in: ids } }).select(PRODUCT_FIELDS).lean();
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
 * This is the only place a price is computed: the cart preview, the counter
 * preview and both order routes call it, so what a customer is shown is what
 * is charged. Combos are applied by `combo-optimizer.solve`, which finds the
 * cheapest total for the customer — several different combos may apply to one
 * cart, each any number of times.
 *
 * Availability is a single rule, `Product.findSellable(channel)`: a product
 * counts only when `available` is true and its `salesChannel` allows `channel`.
 * There is deliberately no flag to relax it — it would let a direct sale sell
 * `available: false` stock. `channel` has no default: a caller that forgets it
 * would silently sell on the wrong channel, so it throws instead.
 *
 * Duplicate `productId` lines are merged rather than rejected, because a cart
 * legitimately reaches this point with the same product added twice. The
 * result is independent of line order.
 *
 * @param {Array<{productId: string, quantity: number}>} items
 *        Cart lines. Lines sharing a productId are summed.
 * @param {object} [opts]
 * @param {'online'|'offline'} opts.channel Required. Where the order is placed.
 * @param {import('mongoose').ClientSession|null} [opts.session=null]
 *        Pass when called inside a transaction; every query issued here must
 *        then run with `.session(session)`. Null runs outside a transaction
 *        (read-only previews).
 * @param {number} [opts.stateBudget] Combo search limit; tests lower it to
 *        reach CART_TOO_COMPLEX cheaply. Defaults to the optimizer's own.
 * @returns {Promise<{
 *   originalTotal: number,
 *   totalAmount: number,
 *   savings: number,
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
 *     savings: number,
 *     originalTotal: number,
 *     finalTotal: number,
 *     combos: Array<{comboId: import('mongoose').Types.ObjectId, comboName: string, applications: number, savings: number}>
 *   }|null,
 *   products: Map<string, object>
 * }>}
 *        `orderItems[].productId` is an ObjectId, not a string, so the result
 *        can be written to an Order without re-casting. Combo lines keep the
 *        retail unit price; `totalAmount` is NOT their price x quantity.
 *        `comboInfo` covers the combo lines only: `originalTotal` is their retail
 *        value and `finalTotal` what the combos charge for them, so
 *        `totalAmount = comboInfo.finalTotal + retail lines` — the identity the
 *        database importer relies on to rebuild a stored order's total.
 *        `products` is keyed by `productId.toString()` so callers can reuse the
 *        already-loaded objects instead of querying again.
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
	let totalUnits = 0;
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
		totalUnits += quantity;
		// Checked inside the loop so a huge quantity cannot overflow the sum
		// before the cap is applied.
		if (totalUnits > MAX_UNITS_PER_ORDER) {
			throw new PricingError(ERROR_CODES.CART_TOO_MANY_UNITS, { maxUnits: MAX_UNITS_PER_ORDER });
		}
	}

	// Sorted so every derived structure (unit order, tie-breaks, orderItems)
	// is the same for any ordering of the client's lines.
	const ids = [...qtyByProductId.keys()].sort();

	// Query 1/2 — products, filtered by the single sellable-on-channel rule.
	const productMap = await loadSellableProducts(ids, channel, session);
	const lines = ids.map((id) => ({ id, product: productMap.get(id), quantity: qtyByProductId.get(id) }));

	// Query 2/2 — combos that apply on this channel.
	let comboQuery = Combo.findSellable(channel).select(COMBO_FIELDS).lean();
	if (session) comboQuery = comboQuery.session(session);
	const combos = await comboQuery;

	// Units of one category, dearest first; equal prices fall back to product id.
	const unitsByCategory = new Map();
	for (const line of lines) {
		const { category, price } = line.product;
		if (!unitsByCategory.has(category)) unitsByCategory.set(category, []);
		for (let i = 0; i < line.quantity; i++) unitsByCategory.get(category).push({ productId: line.id, price });
	}
	for (const units of unitsByCategory.values()) {
		units.sort((a, b) => b.price - a.price || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
	}

	let solved;
	try {
		solved = solve(
			Object.fromEntries([...unitsByCategory].map(([category, units]) => [category, units.map((unit) => unit.price)])),
			combos.map((combo) => ({
				id: combo._id.toString(),
				price: combo.price,
				priority: combo.priority,
				requirements: combo.categoryRequirements.map((requirement) => ({
					category: requirement.category,
					quantity: requirement.quantity,
				})),
			})),
			opts.stateBudget === undefined ? undefined : { stateBudget: opts.stateBudget }
		);
	} catch (error) {
		if (error instanceof StateBudgetExceededError) throw new PricingError(ERROR_CODES.CART_TOO_COMPLEX);
		throw error;
	}

	// Hand the dearest units of each category to the applications, in the
	// optimizer's combo order, so the same cart always yields the same lines.
	const comboById = new Map(combos.map((combo) => [combo._id.toString(), combo]));
	const nextUnit = new Map();
	const inComboByProduct = new Map();
	const orderItems = [];
	const comboSummaries = [];
	let comboRetailValue = 0;
	let comboCharged = 0;

	for (const { id: comboId, count } of solved.applications) {
		const combo = comboById.get(comboId);
		const taken = new Map();
		for (const [category, quantity] of mergeRequirements(combo.categoryRequirements)) {
			const units = unitsByCategory.get(category);
			const start = nextUnit.get(category) || 0;
			const end = start + quantity * count;
			for (let i = start; i < end; i++) {
				taken.set(units[i].productId, (taken.get(units[i].productId) || 0) + 1);
			}
			nextUnit.set(category, end);
		}

		let retailValue = 0;
		for (const productId of [...taken.keys()].sort()) {
			const product = productMap.get(productId);
			const quantity = taken.get(productId);
			retailValue += product.price * quantity;
			inComboByProduct.set(productId, (inComboByProduct.get(productId) || 0) + quantity);
			orderItems.push({
				productId: product._id,
				productName: product.name,
				price: product.price,
				quantity,
				fromCombo: true,
				comboId: combo._id,
				comboName: combo.name,
			});
		}

		const charged = count * combo.price;
		comboRetailValue += retailValue;
		comboCharged += charged;
		comboSummaries.push({ comboId: combo._id, comboName: combo.name, applications: count, savings: retailValue - charged });
	}

	let retailTotal = 0;
	for (const line of lines) {
		const quantity = line.quantity - (inComboByProduct.get(line.id) || 0);
		if (quantity <= 0) continue;
		retailTotal += line.product.price * quantity;
		orderItems.push({
			productId: line.product._id,
			productName: line.product.name,
			price: line.product.price,
			quantity,
			fromCombo: false,
			comboId: null,
			comboName: null,
		});
	}

	const originalTotal = lines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
	const totalAmount = comboCharged + retailTotal;
	const savings = originalTotal - totalAmount;

	// Unreachable while the optimizer and the unit allocation agree; it exists
	// so a drift between them fails loudly instead of mis-charging.
	if (savings !== solved.savings) {
		throw new Error(`pricing saving ${savings} differs from optimizer saving ${solved.savings}`);
	}

	const comboInfo = comboSummaries.length === 0 ? null : {
		savings: comboRetailValue - comboCharged,
		originalTotal: comboRetailValue,
		finalTotal: comboCharged,
		combos: comboSummaries,
	};

	return { originalTotal, totalAmount, savings, orderItems, comboInfo, products: productMap };
}

/**
 * Reject an order whose client-shown total no longer equals the recomputed one.
 * A price can change between preview and checkout; charging a different amount
 * than the customer saw is worse than asking them to look again.
 *
 * @param {number} expectedTotal the total the client displayed
 * @param {number} totalAmount the total just recomputed from the database
 * @throws {PricingError} PRICE_CHANGED (409), details carry both totals
 */
function assertExpectedTotal(expectedTotal, totalAmount) {
	if (expectedTotal !== totalAmount) {
		throw new PricingError(ERROR_CODES.PRICE_CHANGED, { expectedTotal, totalAmount });
	}
}

module.exports = {
	computeOrderPricing,
	assertExpectedTotal,
	loadSellableProducts,
	describePricingError,
	pricingErrorBody,
	PricingError,
	MAX_UNITS_PER_ORDER,
};
