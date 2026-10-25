/**
 * Admin edits of the products inside an existing order.
 *
 * The order's stored `totalAmount` is the contract: the new item set is priced
 * by the same engine that priced the order (today's prices and combos, the
 * order's channel) and is accepted only when it adds up to exactly that total.
 * The total is never taken from the request and never rewritten, so an edit can
 * swap a colour or move units between products but cannot change what the
 * customer owes.
 *
 * The write is a compare-and-set on `status` and `itemsRevision`, and the stock
 * movements for the unit differences commit in the same transaction, so an order
 * never claims items its stock ledger does not back. Call
 * `enqueueMovements(result.movements)` after this resolves.
 */
const { orders, withTransaction } = require('../data');
const { computeOrderPricing } = require('./pricing');
const { unitsByProduct } = require('./stock');
const { recordMovement, keyIdOf } = require('./stock-ledger');

const EDITABLE_ORDER_STATUSES = ['confirmed', 'paid'];

/** Units gained (+) or lost (-) per product between two item sets; zero differences are dropped. */
function unitDifferences(previousItems, nextItems) {
	const before = unitsByProduct(previousItems);
	const after = unitsByProduct(nextItems);
	const differences = new Map();
	for (const productId of new Set([...before.keys(), ...after.keys()])) {
		const difference = (after.get(productId) || 0) - (before.get(productId) || 0);
		if (difference !== 0) differences.set(productId, difference);
	}
	return differences;
}

/**
 * @param {{orderId: string, items: Array<{productId: string, quantity: number}>,
 *          expectedRevision: number, reason: string, actor: string}} edit
 * @returns {Promise<{outcome: 'not_found'|'final'|'changed'|'total_changed'|'unchanged'|'ok',
 *                    order?: object, movements?: Array<object>,
 *                    expected?: number, actual?: number}>}
 *          `changed`: the order's revision or status moved since the client read it.
 *          `total_changed`: carries the stored total (`expected`) and the new set's (`actual`).
 *          `unchanged`: the new set holds the same units per product, nothing written.
 * @throws {import('./pricing').PricingError} the engine refuses the new item set
 */
function editOrderItems({ orderId, items, expectedRevision, reason, actor }) {
	return withTransaction(async (tx) => {
		// Everything is read again on every run: the driver re-runs this callback
		// after a transient error or a write conflict with a racing edit or cancel.
		const existing = await orders.findById(orderId, tx);
		if (!existing) return { outcome: 'not_found' };
		// Only confirmed and paid orders are editable; a final order, or a legacy
		// status the enum no longer has, is answered as final.
		if (!EDITABLE_ORDER_STATUSES.includes(existing.status)) return { outcome: 'final' };

		// Orders stored before the field existed have none: that is revision 0.
		const currentRevision = existing.itemsRevision ?? 0;
		if (expectedRevision !== currentRevision) return { outcome: 'changed' };

		const pricing = await computeOrderPricing(items, {
			channel: existing.isDirectSale ? 'offline' : 'online',
			session: tx,
			// An order with a storefront is re-priced inside it; a legacy or mixed
			// counter order (null) keeps the unrestricted scope it was sold under.
			scope: { storefrontId: existing.storefrontId ?? null },
			// The admin is amending an order that already exists, not selling to a customer.
			enforceQuantityLimits: false
		});
		if (pricing.totalAmount !== existing.totalAmount) {
			return { outcome: 'total_changed', expected: existing.totalAmount, actual: pricing.totalAmount };
		}

		const differences = unitDifferences(existing.items, pricing.orderItems);
		if (differences.size === 0) return { outcome: 'unchanged', order: existing };

		const newRevision = currentRevision + 1;
		const order = await orders.replaceItems({
			orderId,
			fromStatus: existing.status,
			fromRevision: currentRevision,
			items: pricing.orderItems,
			comboInfo: pricing.comboInfo,
			historyEntry: {
				previousItems: existing.items,
				previousComboInfo: existing.comboInfo ?? null,
				editedBy: actor,
				editedAt: new Date(),
				reason
			}
		}, tx);
		if (!order) return { outcome: 'changed' };

		const movements = [];
		if (existing.stockDeducted === true) {
			// Sequential: one transaction cannot run concurrent operations.
			for (const [productId, difference] of differences) {
				movements.push(await recordMovement({
					productId,
					type: 'order_edit',
					delta: -difference,
					orderId: order._id,
					// The admin's own reason lives in itemsHistory; the ledger caps text at 200 characters.
					reason: `Sửa đơn ${order.orderCode}`,
					createdBy: actor,
					idempotencyKey: `order:${keyIdOf(order._id)}:${keyIdOf(productId)}:edit:${newRevision}`
				}, { tx }));
			}
		}
		return { outcome: 'ok', order, movements };
	});
}

module.exports = { editOrderItems };
