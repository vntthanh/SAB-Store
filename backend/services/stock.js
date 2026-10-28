/**
 * What an order does to stock, expressed as stock-ledger movements.
 *
 * `Product.stockQuantity` is never written here: an order records pending
 * movements in the SAME transaction that creates or changes it, and the queue
 * worker applies them later (see services/stock-ledger.js). Stock is never
 * checked, so an order for a product with none left is accepted and the cache
 * simply goes negative.
 *
 * `Order.stockDeducted` is the only thing that says whether an order currently
 * holds stock, which is what keeps a cancel from returning units that were
 * never taken (orders created before stock was tracked per order) and keeps two
 * cancels from returning them twice.
 */
const { orders, withTransaction } = require('../data');
const { recordMovement, keyIdOf } = require('./stock-ledger');
const { logEvent } = require('../utils/log-event');

const { FINAL_ORDER_STATUSES } = orders;

const MOVEMENT_SIGN = { order: -1, order_cancel: 1 };

/**
 * Units per variant across all lines: a combo line and a retail line of one
 * variant count together. A line that names no variant (a product without
 * options on the Mongo rollback store, or a line of a product deleted before
 * variants existed) counts as its product's, keyed by the product id.
 *
 * @returns {Map<string, {productId: string, variantId: string|null, quantity: number}>}
 */
function unitsByVariant(items) {
	const units = new Map();
	for (const item of items) {
		const variantId = item.variantId == null ? null : String(item.variantId);
		const key = variantId ?? String(item.productId);
		const entry = units.get(key) || { productId: String(item.productId), variantId, quantity: 0 };
		entry.quantity += item.quantity;
		units.set(key, entry);
	}
	return units;
}

/**
 * Record one pending movement per variant of an order. Call inside the
 * transaction that writes the order, then `enqueueMovements` after it commits.
 *
 * `keyTag` makes the idempotency key unique per event of the order: creating is
 * `create`, while every cancel carries the order's status-history
 * length so its key stays unique per event of the order.
 *
 * The idempotency key names the variant, or the product for a line without one,
 * which is the key every order had before variants existed.
 *
 * @param {{orderId: *, items: Array<{productId: *, variantId?: *, quantity: number}>, type: 'order'|'order_cancel',
 *          keyTag: string, createdBy: string, reason: string}} movement
 * @param {{tx?: object, session?: object}} opts the transaction; callers may pass it as `tx` or `session`
 * @returns {Promise<Array<object>>}
 */
async function recordOrderMovements({ orderId, items, type, keyTag, createdBy, reason }, opts) {
	const tx = opts.tx || opts.session;
	const sign = MOVEMENT_SIGN[type];
	const recorded = [];
	// Sequential: one transaction cannot run concurrent operations.
	for (const [key, { productId, variantId, quantity }] of unitsByVariant(items)) {
		recorded.push(await recordMovement({
			productId,
			variantId,
			type,
			delta: sign * quantity,
			orderId,
			reason,
			createdBy,
			idempotencyKey: `order:${keyIdOf(orderId)}:${keyIdOf(key)}:${keyTag}`
		}, { tx }));
	}
	return recorded;
}

/**
 * Decide the stock effect of an order status change from the order's own state.
 *
 * - cancelling an order that holds stock gives it back;
 * - anything else, including cancelling an order that never held stock, does
 *   nothing. Cancelled is final, so there is no way back to taking stock again.
 *
 * @returns {{type: 'order_cancel', stockDeducted: boolean}|null}
 *          the movement to record and the new `stockDeducted` to store, or null
 */
function stockEffectOfTransition({ stockDeducted, previousStatus, newStatus }) {
	if (newStatus === 'cancelled' && previousStatus !== 'cancelled' && stockDeducted) {
		return { type: 'order_cancel', stockDeducted: false };
	}
	return null;
}

/**
 * Change an order's status and, in the same transaction, record the stock
 * movement the change calls for (see `stockEffectOfTransition`). Either both are
 * stored or neither is, so an order never claims a status its stock cannot back.
 *
 * Two requests racing the same order cannot both win: a write conflict makes the
 * driver re-run the loser, which then reads the winner's status. Call
 * `enqueueMovements(result.movements)` after this resolves.
 *
 * @param {{orderId: string, status: string, setFields: object, historyEntry: object, actor: string}} change
 *        `setFields` / `historyEntry` carry the status and whatever else the
 *        route records (transaction code, cancel reason, note, who).
 * @returns {Promise<{outcome: 'not_found'|'final'|'unchanged'|'conflict'|'ok', order?: object,
 *                    movements?: Array<object>}>}
 *          `final` means the order is cancelled or delivered and refuses any status
 *          change; `unchanged` means it already has `status`.
 */
async function transitionOrderWithStock({ orderId, status, setFields, historyEntry, actor }) {
	const result = await withTransaction(async (tx) => {
		const existing = await orders.findById(orderId, tx);
		if (!existing) return { outcome: 'not_found' };
		// Read inside the transaction so a cancel racing a delivery sees the winner.
		if (FINAL_ORDER_STATUSES.includes(existing.status)) return { outcome: 'final' };
		if (existing.status === status) return { outcome: 'unchanged' };

		const effect = stockEffectOfTransition({
			stockDeducted: existing.stockDeducted === true,
			previousStatus: existing.status,
			newStatus: status
		});

		const order = await orders.applyStatusChange({
			orderId,
			fromStatus: existing.status,
			fields: { ...setFields, ...(effect && { stockDeducted: effect.stockDeducted }) },
			historyEntry
		}, tx);
		if (!order) return { outcome: 'conflict' };
		if (!effect) return { outcome: 'ok', order, movements: [], from: existing.status };

		const movements = await recordOrderMovements({
			orderId: order._id,
			items: order.items,
			type: effect.type,
			keyTag: `cancel:${order.statusHistory.length}`,
			createdBy: actor,
			reason: `Huỷ đơn ${order.orderCode}`
		}, { tx });
		return { outcome: 'ok', order, movements, from: existing.status };
	});

	// After the commit: the callback may run more than once, and a rolled-back
	// change must leave no trace of having happened.
	if (result.outcome === 'ok') logEvent('order.status', { from: result.from, to: status });
	return result;
}

module.exports = { unitsByVariant, recordOrderMovements, transitionOrderWithStock };
