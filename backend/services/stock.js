/**
 * Atomic stock mutation path — the single place `Product.stockQuantity` is
 * ever written from a code path that handles money or inventory.
 *
 * No replica set exists in production (AD-4 — the required `rs.initiate`
 * command crashes mongo without a keyfile; verified experimentally, see the
 * plan). Every invariant here is therefore enforced with a single guarded
 * `findOneAndUpdate` instead of a multi-document transaction:
 *   - No overselling: the update's filter requires
 *     `stockQuantity >= quantity` for a deduction, so two concurrent buyers
 *     of the last unit race the same atomic operation and exactly one wins —
 *     the loser gets `null` back, never a negative stock value.
 *   - A multi-item order that fails partway through never leaves stock
 *     deducted for the lines that already succeeded: `deductStockForItems`
 *     tracks what it applied and compensates (restores) it in reverse order
 *     inside `catch` before re-throwing.
 *
 * Every function accepts an optional, nullable `session` so enabling a
 * transaction later (if a replica set is ever introduced) needs no call-site
 * changes — passing `session: null` today is a fully supported mode, not a
 * degraded one.
 */

const Product = require('../models/Product');
const ErrorLogger = require('../utils/errorLogger');

/** Error thrown for every rejected stock mutation. Always maps to an HTTP 4xx. */
class StockError extends Error {
	/**
	 * @param {'INVALID_QUANTITY'|'INVALID_DELTA'|'INSUFFICIENT_STOCK'|'PRODUCT_NOT_FOUND'} code
	 * @param {{productId?: string, quantity?: number, delta?: number, requested?: number}} [details]
	 */
	constructor(code, details = {}) {
		super(code);
		this.name = 'StockError';
		this.code = code;
		this.httpStatus = code === 'INSUFFICIENT_STOCK' || code === 'INVALID_QUANTITY' || code === 'INVALID_DELTA' ? 400 : 404;
		this.details = details;
	}
}

function assertPositiveInt(quantity, productId) {
	if (!Number.isInteger(quantity) || quantity <= 0) {
		throw new StockError('INVALID_QUANTITY', { productId, quantity });
	}
}

/**
 * Apply an arbitrary non-zero integer delta to a product's `stockQuantity`
 * as a single atomic operation.
 *
 * A negative delta is guarded directly in the query filter
 * (`stockQuantity >= -delta`), so the write can never take stock below zero
 * even when many requests race the same document — Mongo evaluates the
 * filter and the update as one atomic step per document, so only writers
 * whose delta still fits the stock available *at the instant they run* can
 * succeed. This is also why schema-level `min: 0` validation cannot be
 * relied on here: Mongoose update validators explicitly ignore `$inc`
 * operations (verified against the Mongoose docs), so the filter guard is
 * the only enforcement that actually runs.
 *
 * @param {string|import('mongoose').Types.ObjectId} productId
 * @param {number} delta
 * @param {{session?: import('mongoose').ClientSession|null}} [opts]
 * @returns {Promise<import('mongoose').Document>} the updated product
 * @throws {StockError} INSUFFICIENT_STOCK (delta < 0, not enough stock) or
 *         PRODUCT_NOT_FOUND (delta >= 0, product does not exist)
 */
async function adjustStock(productId, delta, opts = {}) {
	const session = opts.session || null;

	if (!Number.isInteger(delta) || delta === 0) {
		throw new StockError('INVALID_DELTA', { productId, delta });
	}

	const filter = { _id: productId };
	if (delta < 0) {
		filter.stockQuantity = { $gte: -delta };
	}

	let query = Product.findOneAndUpdate(
		filter,
		{ $inc: { stockQuantity: delta } },
		{ new: true, runValidators: true }
	);
	if (session) query = query.session(session);
	const updated = await query;

	if (!updated) {
		if (delta < 0) {
			throw new StockError('INSUFFICIENT_STOCK', { productId, requested: -delta });
		}
		throw new StockError('PRODUCT_NOT_FOUND', { productId });
	}
	return updated;
}

/** Atomically decrement stock by `quantity` (must be a positive integer). */
async function deductStock(productId, quantity, opts = {}) {
	assertPositiveInt(quantity, productId);
	return adjustStock(productId, -quantity, opts);
}

/** Atomically increment stock by `quantity` (must be a positive integer). */
async function restoreStock(productId, quantity, opts = {}) {
	assertPositiveInt(quantity, productId);
	return adjustStock(productId, quantity, opts);
}

/**
 * Apply `sign * item.quantity` to every item in sequence. If any item fails,
 * every item already applied is compensated (the opposite sign) in reverse
 * order before the original error is re-thrown — an order that cannot be
 * fully deducted (or fully restored) must never leave a partial mutation
 * behind.
 *
 * A compensation failure itself (e.g. the product was deleted between the
 * forward and the reverse write) cannot be un-done automatically — it is
 * logged as critical for manual reconciliation rather than silently
 * swallowed, and the original error still propagates.
 */
async function applyStockDeltaForItems(items, sign, opts = {}) {
	const applied = [];
	try {
		for (const item of items) {
			await adjustStock(item.productId, sign * item.quantity, opts);
			applied.push(item);
		}
		return applied;
	} catch (err) {
		for (const item of applied.reverse()) {
			try {
				await adjustStock(item.productId, -sign * item.quantity, opts);
			} catch (compensationError) {
				ErrorLogger.logCritical(
					'Bù kho thất bại sau khi trừ/hoàn một phần — cần sửa tay',
					compensationError,
					{ productId: item.productId, quantity: item.quantity, sign }
				);
			}
		}
		throw err;
	}
}

/** Deduct stock for every `{productId, quantity}` line; compensates on partial failure. */
function deductStockForItems(items, opts = {}) {
	return applyStockDeltaForItems(items, -1, opts);
}

/** Restore stock for every `{productId, quantity}` line; compensates on partial failure. */
function restoreStockForItems(items, opts = {}) {
	return applyStockDeltaForItems(items, 1, opts);
}

/**
 * Decide and perform the stock side effect (if any) for an order status
 * transition, given the order's current stock-accounting state. Shared by
 * every route that can change an order's status (seller and admin), so the
 * "only deduct/restore for orders that actually deducted stock" rule lives
 * in exactly one place.
 *
 * - cancelling an order that had stock deducted restores it.
 * - un-cancelling a *direct-sale* order that no longer has stock deducted
 *   re-deducts it (guarded — insufficient stock rejects the transition).
 * - a web order (`isDirectSale: false`) never had stock deducted at
 *   creation (business decision, unchanged by this phase) and this function
 *   never deducts it on any transition either, cancel or un-cancel.
 *
 * @returns {Promise<boolean|null>} the new `stockDeducted` value the caller
 *          should persist on the order, or `null` if no stock action applied.
 * @throws {StockError} if a required re-deduction cannot be satisfied.
 */
async function applyStatusTransitionStockEffect(
	{ items, isDirectSale, stockDeducted, previousStatus, newStatus },
	opts = {}
) {
	if (newStatus === 'cancelled' && previousStatus !== 'cancelled' && stockDeducted) {
		await restoreStockForItems(items, opts);
		return false;
	}

	if (previousStatus === 'cancelled' && newStatus !== 'cancelled' && isDirectSale && !stockDeducted) {
		await deductStockForItems(items, opts);
		return true;
	}

	return null;
}

module.exports = {
	StockError,
	adjustStock,
	deductStock,
	restoreStock,
	deductStockForItems,
	restoreStockForItems,
	applyStatusTransitionStockEffect,
};
