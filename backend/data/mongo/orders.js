/**
 * Order queries that stock and order-edit transactions need. `tx` is the
 * transaction handed out by `withTransaction`; every function here must run
 * inside it so reads and writes see the same snapshot.
 */
const Order = require('../../models/Order');

const { FINAL_ORDER_STATUSES } = Order;

/**
 * The order as stored, as a plain object with a string `_id`, or null.
 *
 * @param {string} orderId
 * @param {object} tx
 */
async function findById(orderId, tx) {
	const order = await Order.findById(orderId).session(tx).lean();
	return order ? { ...order, _id: String(order._id) } : null;
}

/**
 * Compare-and-set a status change: stores `fields` and appends `historyEntry`
 * only when the order still has `fromStatus`. Returns the updated order (a
 * document, see the contract in data/index.js), or null when another writer
 * changed the status first.
 *
 * @param {{orderId: string, fromStatus: string, fields: object, historyEntry: object}} change
 * @param {object} tx
 */
function applyStatusChange({ orderId, fromStatus, fields, historyEntry }, tx) {
	return Order.findOneAndUpdate(
		{ _id: orderId, status: fromStatus },
		{
			$set: fields,
			$push: { statusHistory: historyEntry }
		},
		{ new: true, runValidators: true, session: tx }
	);
}

/**
 * Compare-and-set an item edit: replaces the items and combo info, bumps the
 * revision and appends `historyEntry` only when the order still has `fromStatus`
 * and `fromRevision`. Returns the updated order (a document, see the contract in
 * data/index.js), or null when it moved.
 *
 * Revision 0 also matches an order stored before the field existed.
 *
 * @param {{orderId: string, fromStatus: string, fromRevision: number, items: Array<object>,
 *          comboInfo: *, historyEntry: object}} edit
 * @param {object} tx
 */
function replaceItems({ orderId, fromStatus, fromRevision, items, comboInfo, historyEntry }, tx) {
	return Order.findOneAndUpdate(
		{
			_id: orderId,
			status: fromStatus,
			// A missing field matches `null`, which is how a legacy order is found.
			itemsRevision: fromRevision === 0 ? { $in: [0, null] } : fromRevision
		},
		{
			$set: { items, comboInfo },
			$inc: { itemsRevision: 1 },
			$push: { itemsHistory: historyEntry }
		},
		{ new: true, runValidators: true, session: tx }
	);
}

module.exports = { FINAL_ORDER_STATUSES, findById, applyStatusChange, replaceItems };
