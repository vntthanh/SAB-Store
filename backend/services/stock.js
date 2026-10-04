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
const Order = require('../models/Order');
const { recordMovement } = require('./stock-ledger');
const { withTransaction } = require('../utils/transaction');

const MOVEMENT_SIGN = { order: -1, order_cancel: 1, order_restore: -1 };

/** Units per product across all lines: a combo line and a retail line of one product count together. */
function unitsByProduct(items) {
	const units = new Map();
	for (const item of items) {
		const key = String(item.productId);
		units.set(key, (units.get(key) || 0) + item.quantity);
	}
	return units;
}

/**
 * Record one pending movement per product of an order. Call inside the
 * transaction that writes the order, then `enqueueMovements` after it commits.
 *
 * `keyTag` makes the idempotency key unique per event of the order: creating is
 * `create`, while every cancel / restore carries the order's status-history
 * length so cancelling, restoring and cancelling again do not collide.
 *
 * @param {{orderId: *, items: Array<{productId: *, quantity: number}>, type: 'order'|'order_cancel'|'order_restore',
 *          keyTag: string, createdBy: string, reason: string}} movement
 * @param {{session: import('mongoose').ClientSession}} opts
 * @returns {Promise<Array<import('mongoose').Document>>}
 */
async function recordOrderMovements({ orderId, items, type, keyTag, createdBy, reason }, { session }) {
	const sign = MOVEMENT_SIGN[type];
	const recorded = [];
	// Sequential: one transaction session cannot run concurrent operations.
	for (const [productId, quantity] of unitsByProduct(items)) {
		recorded.push(await recordMovement({
			productId,
			type,
			delta: sign * quantity,
			orderId,
			reason,
			createdBy,
			idempotencyKey: `order:${orderId}:${productId}:${keyTag}`
		}, { session }));
	}
	return recorded;
}

/**
 * Decide the stock effect of an order status change from the order's own state.
 *
 * - cancelling an order that holds stock gives it back;
 * - un-cancelling an order that holds none takes it again (any order, web or
 *   counter: both hold stock from creation now);
 * - anything else, including cancelling an order that never held stock, does
 *   nothing.
 *
 * @returns {{type: 'order_cancel'|'order_restore', stockDeducted: boolean}|null}
 *          the movement to record and the new `stockDeducted` to store, or null
 */
function stockEffectOfTransition({ stockDeducted, previousStatus, newStatus }) {
	if (newStatus === 'cancelled' && previousStatus !== 'cancelled' && stockDeducted) {
		return { type: 'order_cancel', stockDeducted: false };
	}
	if (previousStatus === 'cancelled' && newStatus !== 'cancelled' && !stockDeducted) {
		return { type: 'order_restore', stockDeducted: true };
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
 * @returns {Promise<{outcome: 'not_found'|'unchanged'|'conflict'|'ok', order?: import('mongoose').Document,
 *                    movements?: Array<import('mongoose').Document>}>}
 *          `unchanged` means the order already has `status`.
 */
function transitionOrderWithStock({ orderId, status, setFields, historyEntry, actor }) {
	return withTransaction(async (session) => {
		const existing = await Order.findById(orderId).session(session).lean();
		if (!existing) return { outcome: 'not_found' };
		if (existing.status === status) return { outcome: 'unchanged' };

		const effect = stockEffectOfTransition({
			stockDeducted: existing.stockDeducted === true,
			previousStatus: existing.status,
			newStatus: status
		});

		const order = await Order.findOneAndUpdate(
			{ _id: orderId, status: existing.status },
			{
				$set: { ...setFields, ...(effect && { stockDeducted: effect.stockDeducted }) },
				$push: { statusHistory: historyEntry }
			},
			{ new: true, runValidators: true, session }
		);
		if (!order) return { outcome: 'conflict' };
		if (!effect) return { outcome: 'ok', order, movements: [] };

		const tag = effect.type === 'order_cancel' ? 'cancel' : 'restore';
		const movements = await recordOrderMovements({
			orderId: order._id,
			items: order.items,
			type: effect.type,
			keyTag: `${tag}:${order.statusHistory.length}`,
			createdBy: actor,
			reason: `${effect.type === 'order_cancel' ? 'Huỷ' : 'Bỏ huỷ'} đơn ${order.orderCode}`
		}, { session });
		return { outcome: 'ok', order, movements };
	});
}

module.exports = { recordOrderMovements, stockEffectOfTransition, transitionOrderWithStock };
