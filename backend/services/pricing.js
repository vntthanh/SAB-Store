/**
 * Server-side order pricing.
 *
 * Every monetary figure an order is stored with must come from this module.
 * Prices, totals and combo savings sent by a client are advisory at best and
 * hostile at worst, so they are read from the database instead of trusted.
 */

const { products, combos } = require('../data');
const { isRecordId, normalizeRecordId } = require('../data/ids');
const { solve, mergeRequirements, StateBudgetExceededError } = require('./combo-optimizer');
const { ERROR_CODES } = require('../constants/errorCodes');

/**
 * Error thrown for every rejected pricing request.
 *
 * HTTP 400 for every code except PRICE_CHANGED and QUANTITY_OVER_MAX (409, both
 * answered by the caller confirming and resending): each 400 describes a cart the
 * caller could have validated before sending, never a server fault.
 */
class PricingError extends Error {
	/**
	 * @param {'EMPTY_CART'|'PRODUCT_UNAVAILABLE'|'PRODUCT_CHANNEL_MISMATCH'|'ORDER_MIXED_STOREFRONTS'|'INVALID_QUANTITY'|'CART_TOO_MANY_UNITS'|'CART_TOO_COMPLEX'|'PRICE_CHANGED'|'QUANTITY_OUT_OF_RANGE'|'QUANTITY_OVER_MAX'|'VARIANT_REQUIRED'|'VARIANT_UNAVAILABLE'} code
	 * @param {{missingIds?: string[], productId?: string, productNames?: string[], channel?: string,
	 *          expectedTotal?: number, totalAmount?: number, productName?: string, quantity?: number,
	 *          min?: number, max?: number|null, reason?: 'below_min'|'above_max',
	 *          lines?: Array<{productId: string, productName: string, quantity: number, max: number}>
	 *                  |Array<{productId: string, variantId: string|null}>}} [details]
	 *        `lines` depends on the code: QUANTITY_OVER_MAX lists the products over their
	 *        maximum; VARIANT_REQUIRED and VARIANT_UNAVAILABLE list the cart lines at fault.
	 */
	constructor(code, details = {}) {
		super(code);
		this.name = 'PricingError';
		this.code = code;
		this.httpStatus = code === ERROR_CODES.PRICE_CHANGED || code === ERROR_CODES.QUANTITY_OVER_MAX ? 409 : 400;
		this.details = details;
	}
}

// Only what the engine reads, so the stock cache and other internals are never
// loaded. The combo search itself stays in Node: a dynamic program as an
// aggregation pipeline would run on the small mongod (512 MB, 0.25 GB cache)
// and be slower than this in-memory one.
const PRODUCT_FIELDS = ['_id', 'name', 'price', 'category', 'minOrderQuantity', 'maxOrderQuantity', 'available', 'salesChannel', 'storefrontId', 'variants'];
const COMBO_FIELDS = ['_id', 'name', 'price', 'categoryRequirements', 'priority', 'salesChannel', 'isActive', 'storefrontIds'];

const CHANNEL_LABELS = { online: 'online', offline: 'tại quầy' };

// Largest order, in units, the engine prices. It bounds the combo search and
// the stock work a single order can trigger.
const MAX_UNITS_PER_ORDER = 200;

const PRICING_ERROR_MESSAGES = {
	[ERROR_CODES.CART_TOO_MANY_UNITS]: `Mỗi đơn hàng tối đa ${MAX_UNITS_PER_ORDER} sản phẩm`,
	[ERROR_CODES.CART_TOO_COMPLEX]: 'Giỏ hàng quá phức tạp để tính giá, vui lòng tách thành nhiều đơn',
	[ERROR_CODES.PRICE_CHANGED]: 'Giá vừa thay đổi, vui lòng xem lại giỏ hàng',
	[ERROR_CODES.QUANTITY_OVER_MAX]: 'Số lượng vượt mức tối đa, cần xác nhận để bán',
	EMPTY_CART: 'Danh sách sản phẩm không hợp lệ',
	PRODUCT_UNAVAILABLE: 'Một hoặc nhiều sản phẩm không tồn tại hoặc không khả dụng',
	INVALID_QUANTITY: 'Số lượng sản phẩm không hợp lệ',
	[ERROR_CODES.ORDER_MIXED_STOREFRONTS]: 'Đơn hàng chỉ được gồm sản phẩm của một gian hàng',
	[ERROR_CODES.VARIANT_REQUIRED]: 'Vui lòng chọn phân loại cho sản phẩm',
	[ERROR_CODES.VARIANT_UNAVAILABLE]: 'Phân loại sản phẩm không còn bán',
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
	if (error.code === ERROR_CODES.QUANTITY_OUT_OF_RANGE) {
		const { productName, reason, min, max } = error.details;
		return reason === 'below_min'
			? `${productName}: số lượng tối thiểu là ${min}`
			: `${productName}: số lượng tối đa là ${max}`;
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
 * @param {string[]} ids canonical (lowercase) record id strings
 * @param {'online'|'offline'} channel
 * @param {object|null} [tx]
 * @returns {Promise<Map<string, object>>} product records keyed by `String(_id)`
 * @throws {TypeError} channel missing or unknown (a programming error, not a bad cart)
 * @throws {PricingError}
 */
async function loadSellableProducts(ids, channel, tx = null) {
	const sellable = await products.findSellableForPricing(channel, ids, PRODUCT_FIELDS, tx);

	const productMap = new Map(sellable.map((product) => [product._id.toString(), product]));
	const missingIds = ids.filter((id) => !productMap.has(id));
	if (missingIds.length === 0) return productMap;

	const otherChannelNames = await products.findAvailableNames(missingIds, tx);

	if (otherChannelNames.length === missingIds.length) {
		throw new PricingError(ERROR_CODES.PRODUCT_CHANNEL_MISMATCH, {
			missingIds,
			productNames: otherChannelNames,
			channel,
		});
	}
	throw new PricingError('PRODUCT_UNAVAILABLE', { missingIds });
}

/**
 * Check each product's units (all its variants together) against its `minOrderQuantity` /
 * `maxOrderQuantity`. The minimum is a hard limit everywhere. The maximum is
 * hard too, except that a counter sale may exceed it once the cashier has
 * confirmed (`allowOverMax`); the lines that did exceed it are returned so the
 * caller can leave an audit note on the order.
 *
 * @returns {Array<{productId: string, productName: string, quantity: number, max: number}>}
 *          lines over their maximum that `allowOverMax` let through
 * @throws {PricingError} QUANTITY_OUT_OF_RANGE (below min, or over max without
 *         `allowOverMax` on the online channel), QUANTITY_OVER_MAX (counter sale
 *         over max, not yet confirmed — carries every such line)
 */
function checkQuantityLimits(lines, { channel, allowOverMax }) {
	const overMax = [];
	for (const { id, product, quantity } of lines) {
		const min = product.minOrderQuantity || 1;
		const max = product.maxOrderQuantity;
		const details = { productId: id, productName: product.name, quantity, min, max: max ?? null };
		if (quantity < min) {
			throw new PricingError(ERROR_CODES.QUANTITY_OUT_OF_RANGE, { ...details, reason: 'below_min' });
		}
		if (max == null || quantity <= max) continue;
		if (channel !== 'offline') {
			throw new PricingError(ERROR_CODES.QUANTITY_OUT_OF_RANGE, { ...details, reason: 'above_max' });
		}
		overMax.push({ productId: id, productName: product.name, quantity, max });
	}

	if (overMax.length > 0 && !allowOverMax) {
		throw new PricingError(ERROR_CODES.QUANTITY_OVER_MAX, { lines: overMax });
	}
	return overMax;
}

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byProductThenKey = (a, b) => compareText(a.productId, b.productId) || compareText(a.key, b.key);

/**
 * The variant each requested line buys, with its unit price, merged per variant.
 *
 * A line naming a variant must name an active variant of its product. A line
 * naming none buys the product's default variant (a product without options); a
 * product with options needs the variant named, so an old cart line never buys
 * an option the customer did not pick. Every bad line is reported at once, so a
 * cart can drop exactly those. A store without variants (the Mongo rollback)
 * sells the product itself and refuses any variant. A variant in `keepVariantIds`
 * is accepted even when it is no longer sold: an order that already holds it
 * stays editable after the variant is retired.
 *
 * @param {Array<{productId: string, variantId: string|null, quantity: number}>} requested canonical ids
 * @param {Map<string, object>} productMap
 * @param {Set<string>} keepVariantIds
 * @returns {Array<{key: string, productId: string, product: object, variant: object|null, unitPrice: number, quantity: number}>}
 *          ordered by product, then variant; `key` is the variant id (the product id on a store without variants)
 * @throws {PricingError} VARIANT_UNAVAILABLE, VARIANT_REQUIRED
 */
function resolveVariants(requested, productMap, keepVariantIds) {
	const lines = new Map();
	const unavailable = [];
	const required = [];
	for (const { productId, variantId, quantity } of requested) {
		const product = productMap.get(productId);
		let variant = null;
		if (product.variants) {
			variant = variantId === null
				? product.variants.find((candidate) => candidate.optionValues.length === 0)
				: product.variants.find((candidate) => candidate._id === variantId);
			if (variantId === null && !variant) {
				required.push({ productId, variantId: null });
				continue;
			}
			if (!variant || (variant.isActive === false && !keepVariantIds.has(variant._id))) {
				unavailable.push({ productId, variantId });
				continue;
			}
		} else if (variantId !== null) {
			unavailable.push({ productId, variantId });
			continue;
		}
		const key = variant ? variant._id : productId;
		const line = lines.get(key) || { key, productId, product, variant, unitPrice: variant ? variant.effectivePrice : product.price, quantity: 0 };
		line.quantity += quantity;
		lines.set(key, line);
	}
	if (unavailable.length > 0) throw new PricingError(ERROR_CODES.VARIANT_UNAVAILABLE, { lines: unavailable });
	if (required.length > 0) throw new PricingError(ERROR_CODES.VARIANT_REQUIRED, { lines: required });
	return [...lines.values()].sort(byProductThenKey);
}

/** Units per product across its variants, for the product's own min/max order quantity. */
function productQuantities(lines) {
	const byProduct = new Map();
	for (const line of lines) {
		const entry = byProduct.get(line.productId) || { id: line.productId, product: line.product, quantity: 0 };
		entry.quantity += line.quantity;
		byProduct.set(line.productId, entry);
	}
	return [...byProduct.values()];
}

/** The stored order line for `quantity` units of a resolved line, inside `combo` or retail. */
function orderItemOf(line, quantity, combo) {
	return {
		productId: line.product._id,
		...(line.variant && { variantId: line.variant._id }),
		productName: line.product.name,
		...(line.variant && line.variant.label && { variantLabel: line.variant.label }),
		price: line.unitPrice,
		quantity,
		fromCombo: Boolean(combo),
		comboId: combo ? combo._id : null,
		comboName: combo ? combo.name : null,
	};
}

/** The storefront a loaded product belongs to; null on a store or a legacy row that has none. */
const storefrontOf = (product) => (product.storefrontId == null ? null : String(product.storefrontId));

/**
 * @param {'single'|'any'|{storefrontId: string|null}} scope
 * @returns {{mode: 'single'|'any'|'scoped', storefrontId?: string}}
 * @throws {TypeError} anything else, so a typo cannot silently widen a price scope
 */
function parseScope(scope) {
	if (scope === 'single' || scope === 'any') return { mode: scope };
	if (scope && typeof scope === 'object' && 'storefrontId' in scope) {
		return scope.storefrontId == null ? { mode: 'any' } : { mode: 'scoped', storefrontId: String(scope.storefrontId) };
	}
	throw new TypeError(`Unknown pricing scope: ${JSON.stringify(scope)}`);
}

/**
 * Split the cart into groups that are priced independently. A combo may only
 * consume units of the storefronts it is linked to, and the optimizer takes one
 * pool of units per category, so a cart spanning storefronts is split into
 * groups of storefronts joined by a shared combo; inside a group a combo is kept
 * only when it covers every storefront of the group, otherwise it could eat units
 * it is not linked to. A partially overlapping combo therefore does not apply to
 * a mixed counter cart: it under-discounts, it never over-discounts.
 *
 * @returns {Array<{lines: object[], combos: object[]}>}
 */
function groupByStorefront(lines, present, sellableCombos) {
	if (present.length === 1) return [{ lines, combos: sellableCombos }];

	const parent = new Map(present.map((id) => [id, id]));
	const root = (id) => {
		while (parent.get(id) !== id) id = parent.get(id);
		return id;
	};
	const linksOf = (combo) => (combo.storefrontIds || []).map(String).filter((id) => parent.has(id));
	for (const combo of sellableCombos) {
		const [first, ...rest] = linksOf(combo);
		for (const other of rest) parent.set(root(other), root(first));
	}

	const groups = new Map();
	for (const id of present) {
		const key = root(id);
		if (!groups.has(key)) groups.set(key, { storefronts: new Set(), lines: [], combos: [] });
		groups.get(key).storefronts.add(id);
	}
	for (const line of lines) groups.get(root(storefrontOf(line.product))).lines.push(line);
	for (const combo of sellableCombos) {
		const linked = new Set(linksOf(combo));
		if (linked.size === 0) continue;
		const group = groups.get(root([...linked][0]));
		if ([...group.storefronts].every((id) => linked.has(id))) group.combos.push(combo);
	}
	return [...groups.values()];
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
 * Availability is a single rule, `products.findSellable(channel)`: a product
 * counts only when `available` is true and its `salesChannel` allows `channel`.
 * There is deliberately no flag to relax it — it would let a direct sale sell
 * `available: false` stock. `channel` has no default: a caller that forgets it
 * would silently sell on the wrong channel, so it throws instead.
 *
 * Duplicate lines of one variant are merged rather than rejected, because a
 * cart legitimately reaches this point with the same variant added twice. Each
 * unit costs its variant's own price, or the product's when the variant has
 * none. The result is independent of line order.
 *
 * @param {Array<{productId: string, variantId?: string|null, quantity: number}>} items
 *        Cart lines. Lines buying the same variant are summed (see `resolveVariants`).
 * @param {object} [opts]
 * @param {'online'|'offline'} opts.channel Required. Where the order is placed.
 * @param {object|null} [opts.tx=null]
 *        The transaction from `withTransaction`; pass it when called inside one
 *        so every query issued here runs in it. Null runs outside a transaction
 *        (read-only previews). Callers may pass it as `tx` or `session`.
 * @param {boolean} [opts.enforceQuantityLimits=false] Enforce each product's
 *        min/max order quantity. Order routes set it; the read-only previews
 *        do not, so a counter cart over a maximum still shows its total and the
 *        cashier gets to the confirmation instead of a blank price.
 * @param {'single'|'any'|{storefrontId: string|null}} [opts.scope='single']
 *        Which storefronts the cart may span. 'single' (the default, so an online
 *        caller that forgets it fails closed) derives the storefront from the
 *        products and refuses a mix with ORDER_MIXED_STOREFRONTS. 'any' is for
 *        the counter: a mix is priced, each combo counting only the lines of its
 *        own storefronts. `{storefrontId}` prices inside that storefront and
 *        refuses a product of another; a null id behaves as 'any'.
 * @param {Iterable<string>} [opts.keepVariantIds] Order edits only: variants the
 *        order already holds, priced even if they are no longer sold.
 * @param {boolean} [opts.allowOverMax=false] Counter sales only: the cashier
 *        confirmed selling above a maximum. Ignored on the online channel.
 * @param {number} [opts.stateBudget] Combo search limit; tests lower it to
 *        reach CART_TOO_COMPLEX cheaply. Defaults to the optimizer's own.
 * @returns {Promise<{
 *   storefrontId: string|null,
 *   originalTotal: number,
 *   totalAmount: number,
 *   savings: number,
 *   orderItems: Array<{
 *     productId: NativeId,
 *     variantId?: string,
 *     productName: string,
 *     variantLabel?: string,
 *     price: number,
 *     quantity: number,
 *     fromCombo: boolean,
 *     comboId: NativeId|null,
 *     comboName: string|null
 *   }>,
 *   comboInfo: {
 *     savings: number,
 *     originalTotal: number,
 *     finalTotal: number,
 *     combos: Array<{comboId: NativeId, comboName: string, applications: number, savings: number}>
 *   }|null,
 *   overMaxLines: Array<{productId: string, productName: string, quantity: number, max: number}>,
 *   products: Map<string, object>
 * }>}
 *        `orderItems[].productId` and `comboId` (and `comboInfo.combos[].comboId`)
 *        are the store's native id: an ObjectId on MongoDB, a lowercase uuid
 *        string on postgres. Callers only `String()` them or compare the
 *        normalised form; nothing here depends on it being an object. Combo lines keep the
 *        retail unit price; `totalAmount` is NOT their price x quantity.
 *        `comboInfo` covers the combo lines only: `originalTotal` is their retail
 *        value and `finalTotal` what the combos charge for them, so
 *        `totalAmount = comboInfo.finalTotal + retail lines` — the identity the
 *        database importer relies on to rebuild a stored order's total.
 *        `overMaxLines` lists the lines sold above their maximum on the cashier's
 *        confirmation; empty otherwise.
 *        `products` is keyed by `productId.toString()` so callers can reuse the
 *        already-loaded objects instead of querying again.
 * @throws {TypeError} `opts.channel` is missing or not 'online'/'offline', or `opts.scope` is unknown.
 * @throws {PricingError} An empty cart throws EMPTY_CART; it never returns a
 *        zero total, which would otherwise be indistinguishable from a free order.
 */
async function computeOrderPricing(items, opts = {}) {
	const tx = opts.tx || opts.session || null;
	const channel = opts.channel;
	// Fail before any query: this is the check that makes a forgotten channel
	// impossible to ship, and it must not depend on the cart being valid.
	products.assertSaleChannel(channel);
	const scope = parseScope(opts.scope === undefined ? 'single' : opts.scope);

	if (!Array.isArray(items) || items.length === 0) {
		throw new PricingError('EMPTY_CART');
	}

	// Reduce every id to its canonical form (lowercase; a uuid on postgres): a
	// differently cased id would match the store but fail the strict string
	// comparisons below against the form the store returns. Anything that is not
	// a record id is rejected as an unknown product (or variant).
	const requested = [];
	let totalUnits = 0;
	for (const item of items) {
		const rawId = item && item.productId;
		if (!isRecordId(rawId)) {
			throw new PricingError('PRODUCT_UNAVAILABLE', { missingIds: [String(rawId)] });
		}
		const rawVariantId = item.variantId;
		if (rawVariantId != null && !isRecordId(rawVariantId)) {
			throw new PricingError(ERROR_CODES.VARIANT_UNAVAILABLE, { lines: [{ productId: normalizeRecordId(rawId), variantId: String(rawVariantId) }] });
		}
		const quantity = Number(item.quantity);
		if (!Number.isInteger(quantity) || quantity <= 0) {
			throw new PricingError('INVALID_QUANTITY', { productId: String(rawId) });
		}
		requested.push({ productId: normalizeRecordId(rawId), variantId: rawVariantId == null ? null : normalizeRecordId(rawVariantId), quantity });
		totalUnits += quantity;
		// Checked inside the loop so a huge quantity cannot overflow the sum
		// before the cap is applied.
		if (totalUnits > MAX_UNITS_PER_ORDER) {
			throw new PricingError(ERROR_CODES.CART_TOO_MANY_UNITS, { maxUnits: MAX_UNITS_PER_ORDER });
		}
	}

	// Sorted so every derived structure (unit order, tie-breaks, orderItems)
	// is the same for any ordering of the client's lines.
	const ids = [...new Set(requested.map((line) => line.productId))].sort();

	// Query 1/2 — products and their variants, filtered by the single sellable-on-channel rule.
	const productMap = await loadSellableProducts(ids, channel, tx);
	const lines = resolveVariants(requested, productMap, new Set([...(opts.keepVariantIds || [])].map((id) => normalizeRecordId(id))));
	const present = [...new Set(lines.map((line) => storefrontOf(line.product)))];
	const outsideScope = scope.mode === 'scoped' ? present.some((id) => id !== scope.storefrontId) : scope.mode === 'single' && present.length > 1;
	if (outsideScope) {
		// No product names: the caller may not be allowed to see one of the storefronts, and a name here would show them.
		throw new PricingError(ERROR_CODES.ORDER_MIXED_STOREFRONTS);
	}
	const overMaxLines = opts.enforceQuantityLimits
		? checkQuantityLimits(productQuantities(lines), { channel, allowOverMax: opts.allowOverMax === true })
		: [];

	// Query 2/2 — combos that apply on this channel. One storefront in the cart:
	// only its combos. A mixed counter cart loads them all and splits them below.
	const sellableCombos = await combos.findSellableForPricing(
		channel, COMBO_FIELDS, tx, present.length === 1 && present[0] !== null ? { storefrontId: present[0] } : {}
	);

	const comboById = new Map(sellableCombos.map((combo) => [combo._id.toString(), combo]));
	const lineByKey = new Map(lines.map((line) => [line.key, line]));
	const inComboByKey = new Map();
	const orderItems = [];
	const comboSummaries = [];
	let comboRetailValue = 0;
	let comboCharged = 0;
	let optimizerSavings = 0;

	for (const group of groupByStorefront(lines, present, sellableCombos)) {
		// Units of one category, dearest first; equal prices fall back to product, then variant.
		const unitsByCategory = new Map();
		for (const line of group.lines) {
			const { category } = line.product;
			if (!unitsByCategory.has(category)) unitsByCategory.set(category, []);
			for (let i = 0; i < line.quantity; i++) unitsByCategory.get(category).push({ line, price: line.unitPrice });
		}
		for (const units of unitsByCategory.values()) {
			units.sort((a, b) => b.price - a.price || byProductThenKey(a.line, b.line));
		}

		let solved;
		try {
			solved = solve(
				Object.fromEntries([...unitsByCategory].map(([category, units]) => [category, units.map((unit) => unit.price)])),
				group.combos.map((combo) => ({
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
		optimizerSavings += solved.savings;

		// Hand the dearest units of each category to the applications, in the
		// optimizer's combo order, so the same cart always yields the same lines.
		const nextUnit = new Map();
		for (const { id: comboId, count } of solved.applications) {
			const combo = comboById.get(comboId);
			const taken = new Map();
			for (const [category, quantity] of mergeRequirements(combo.categoryRequirements)) {
				const units = unitsByCategory.get(category);
				const start = nextUnit.get(category) || 0;
				const end = start + quantity * count;
				for (let i = start; i < end; i++) {
					taken.set(units[i].line.key, (taken.get(units[i].line.key) || 0) + 1);
				}
				nextUnit.set(category, end);
			}

			let retailValue = 0;
			for (const line of [...taken.keys()].map((key) => lineByKey.get(key)).sort(byProductThenKey)) {
				const quantity = taken.get(line.key);
				retailValue += line.unitPrice * quantity;
				inComboByKey.set(line.key, (inComboByKey.get(line.key) || 0) + quantity);
				orderItems.push(orderItemOf(line, quantity, combo));
			}

			const charged = count * combo.price;
			comboRetailValue += retailValue;
			comboCharged += charged;
			comboSummaries.push({ comboId: combo._id, comboName: combo.name, applications: count, savings: retailValue - charged });
		}
	}

	let retailTotal = 0;
	for (const line of lines) {
		const quantity = line.quantity - (inComboByKey.get(line.key) || 0);
		if (quantity <= 0) continue;
		retailTotal += line.unitPrice * quantity;
		orderItems.push(orderItemOf(line, quantity, null));
	}

	const originalTotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
	const totalAmount = comboCharged + retailTotal;
	const savings = originalTotal - totalAmount;

	// Unreachable while the optimizer and the unit allocation agree; it exists
	// so a drift between them fails loudly instead of mis-charging.
	if (savings !== optimizerSavings) {
		throw new Error(`pricing saving ${savings} differs from optimizer saving ${optimizerSavings}`);
	}

	const comboInfo = comboSummaries.length === 0 ? null : {
		savings: comboRetailValue - comboCharged,
		originalTotal: comboRetailValue,
		finalTotal: comboCharged,
		combos: comboSummaries,
	};

	return {
		storefrontId: present.length === 1 ? present[0] : null,
		originalTotal, totalAmount, savings, orderItems, comboInfo, overMaxLines, products: productMap
	};
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
	pricingErrorBody,
	PricingError,
	MAX_UNITS_PER_ORDER,
};
