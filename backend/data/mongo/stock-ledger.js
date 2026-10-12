/**
 * Stock-ledger storage: StockMovement rows and the one write of the Product
 * stock cache.
 *
 * `applyClaimed` is the only function in the code base that changes
 * `Product.stockQuantity` after a product exists. Ids go in as strings (or the
 * store's own id objects, which are treated as opaque); a `tx` is the transaction
 * from `withTransaction`.
 */
const mongoose = require('mongoose');
const Product = require('../../models/Product');
const StockMovement = require('../../models/StockMovement');
const { normalizeRecordId } = require('../ids');
const { toSkipTake, buildPaginationMeta } = require('@sab/shared');

const { MOVEMENT_TYPES } = StockMovement;

/** A stored movement as a plain record: `_id` and the referenced ids are strings. */
function toRecord(movement) {
	return {
		...movement,
		_id: String(movement._id),
		productId: String(movement.productId),
		orderId: movement.orderId ? String(movement.orderId) : null
	};
}

/**
 * The movement with this idempotency key, or null.
 *
 * @param {string} idempotencyKey
 * @param {object|null} [tx]
 * @returns {Promise<object|null>}
 */
async function findMovementByKey(idempotencyKey, tx) {
	const query = StockMovement.findOne({ idempotencyKey }).lean();
	const movement = await (tx ? query.session(tx) : query);
	return movement ? toRecord(movement) : null;
}

/**
 * Insert one movement and return it.
 *
 * A taken idempotency key rejects with the store's own duplicate-key error;
 * `isDuplicateKeyError` (data/errors.js) recognises it.
 *
 * @param {object} record fields of the movement, `status`/`appliedAt`/`stockAfter` only for an already-applied one
 * @param {object|null} [tx]
 * @returns {Promise<object>}
 */
async function createMovement(record, tx) {
	const [created] = await StockMovement.create([record], tx ? { session: tx } : undefined);
	return toRecord(created.toObject());
}

/** Movements of the same product apply in (createdAt, _id) order. */
async function hasOlderPending(movement) {
	return Boolean(await StockMovement.exists({
		productId: movement.productId,
		status: 'pending',
		$or: [
			{ createdAt: { $lt: movement.createdAt } },
			{ createdAt: movement.createdAt, _id: { $lt: movement._id } }
		]
	}));
}

/**
 * Decide whether a movement can be applied now and, if so, count the attempt.
 *
 * - `missing`: no such movement, or it is no longer pending;
 * - `deferred`: an older movement of the same product is still pending;
 * - `claimed`: the attempt was counted and the movement is ready for `applyClaimed`.
 *
 * @param {string} movementId
 * @returns {Promise<{state: 'missing'|'deferred'|'claimed', movement?: {_id: string, type: string}}>}
 */
async function claimForApply(movementId) {
	const movement = await StockMovement.findById(movementId).lean();
	if (!movement || movement.status !== 'pending') return { state: 'missing' };

	if (await hasOlderPending(movement)) return { state: 'deferred' };

	await StockMovement.updateOne(
		{ _id: movement._id, status: 'pending' },
		{ $set: { claimedAt: new Date() }, $inc: { attempts: 1 } }
	);
	return { state: 'claimed', movement: { _id: String(movement._id), type: movement.type } };
}

/**
 * Flip a pending movement to applied and move the product cache by its delta, in
 * one transaction gated on the movement still being pending, so exactly one run
 * ever counts. Safe to run any number of times, concurrently or after a crash.
 *
 * @param {string} movementId
 * @returns {Promise<boolean>} true when this run applied it
 */
async function applyClaimed(movementId) {
	const session = await mongoose.startSession();
	let applied = false;
	try {
		// withTransaction re-runs the callback on a transient error (e.g. a write
		// conflict with a concurrent run of the same movement), so it must start
		// from a clean state and re-read everything.
		await session.withTransaction(async () => {
			applied = false;

			const movement = await StockMovement.findOne({ _id: movementId, status: 'pending' }).session(session).lean();
			if (!movement) return;

			const product = await Product.findById(movement.productId).select('stockQuantity').session(session).lean();
			const appliedAt = new Date();

			if (!product) {
				// The product was deleted. Leaving the movement pending would block the
				// queue for a product that no longer exists.
				const res = await StockMovement.updateOne(
					{ _id: movement._id, status: 'pending' },
					{ $set: { status: 'applied', appliedAt, delta: movement.delta ?? 0, lastError: 'PRODUCT_NOT_FOUND' } },
					{ session }
				);
				applied = res.modifiedCount === 1;
				return;
			}

			const current = product.stockQuantity || 0;
			const delta = movement.type === 'set_target' ? movement.target - current : movement.delta;

			// The gate: only the run that flips this movement goes on to touch the product.
			const gate = await StockMovement.updateOne(
				{ _id: movement._id, status: 'pending' },
				{ $set: { status: 'applied', appliedAt, delta, stockAfter: current + delta, lastError: null } },
				{ session }
			);
			if (gate.modifiedCount !== 1) return;

			if (delta !== 0) {
				await Product.updateOne({ _id: movement.productId }, { $inc: { stockQuantity: delta } }, { session });
			}
			applied = true;
		});
	} finally {
		await session.endSession();
	}
	return applied;
}

/**
 * Store the failure text on a movement that is still pending.
 *
 * @param {string} movementId
 * @param {string} errorText cut to 500 characters
 * @returns {Promise<{attempts: number, productId: string}|null>} null when the movement is no longer pending
 */
async function recordApplyFailure(movementId, errorText) {
	const failed = await StockMovement.findOneAndUpdate(
		{ _id: movementId, status: 'pending' },
		{ $set: { lastError: errorText.slice(0, 500) } },
		{ new: true }
	).lean();
	return failed ? { attempts: failed.attempts, productId: String(failed.productId) } : null;
}

/**
 * Ids of pending movements created before `createdBefore`, oldest first.
 *
 * @param {{createdBefore: Date, limit: number}} scan
 * @returns {Promise<string[]>}
 */
async function listPendingIdsCreatedBefore({ createdBefore, limit }) {
	const stale = await StockMovement.find({ status: 'pending', createdAt: { $lt: createdBefore } })
		.sort({ createdAt: 1, _id: 1 })
		.limit(limit)
		.select('_id')
		.lean();
	return stale.map((m) => String(m._id));
}

/**
 * How many movements are pending and when the oldest was created.
 *
 * @returns {Promise<{count: number, oldestCreatedAt: Date|null}>}
 */
async function summarizePending() {
	const [count, oldest] = await Promise.all([
		StockMovement.countDocuments({ status: 'pending' }),
		StockMovement.findOne({ status: 'pending' }).sort({ createdAt: 1, _id: 1 }).select('createdAt').lean()
	]);
	return { count, oldestCreatedAt: oldest ? oldest.createdAt : null };
}

/**
 * What reconcile compares: the sum of applied deltas and the pending count per
 * product (keyed by id string), and every product's cached stock.
 *
 * With a `tx` the three reads run inside it one after another (a transaction
 * runs one operation at a time) and see what the transaction has written.
 *
 * @param {object|null} [tx]
 * @returns {Promise<{appliedSumByProduct: Map<string, number>, pendingByProduct: Map<string, number>,
 *                    products: Array<{productId: string, name: string, stockQuantity?: number}>}>}
 */
async function readLedgerState(tx) {
	const inTx = (query) => (tx ? query.session(tx) : query);
	const sums = await inTx(StockMovement.aggregate([
		{ $match: { status: 'applied' } },
		{ $group: { _id: '$productId', ledgerSum: { $sum: '$delta' } } }
	]));
	const pendingCounts = await inTx(StockMovement.aggregate([
		{ $match: { status: 'pending' } },
		{ $group: { _id: '$productId', pending: { $sum: 1 } } }
	]));
	const products = await inTx(Product.find({}).select('name stockQuantity').lean());
	return {
		appliedSumByProduct: new Map(sums.map((s) => [String(s._id), s.ledgerSum])),
		pendingByProduct: new Map(pendingCounts.map((p) => [String(p._id), p.pending])),
		products: products.map((p) => ({ productId: String(p._id), name: p.name, stockQuantity: p.stockQuantity }))
	};
}

/**
 * What an opening baseline needs for one product: its cached stock and the sum of
 * its applied movements, read inside `tx` so they are one snapshot. Null when
 * the product does not exist.
 *
 * @param {string} productId
 * @param {object} tx
 * @returns {Promise<{stockQuantity: number, appliedSum: number}|null>}
 */
async function readOpeningBasis(productId, tx) {
	const product = await Product.findById(productId).select('stockQuantity').session(tx).lean();
	if (!product) return null;
	const [row] = await StockMovement.aggregate([
		{ $match: { productId: product._id, status: 'applied' } },
		{ $group: { _id: null, sum: { $sum: '$delta' } } }
	]).session(tx);
	return { stockQuantity: product.stockQuantity || 0, appliedSum: row ? row.sum : 0 };
}

/**
 * Number of pending movements per product.
 *
 * @param {Array<string|object>} productIds
 * @returns {Promise<Map<string, number>>}
 */
async function countPendingByProduct(productIds) {
	// The pipeline does not cast, so strings must become ObjectIds first.
	const ids = productIds.map((id) => new mongoose.Types.ObjectId(normalizeRecordId(id)));
	const rows = await StockMovement.aggregate([
		{ $match: { productId: { $in: ids }, status: 'pending' } },
		{ $group: { _id: '$productId', pending: { $sum: 1 } } }
	]);
	return new Map(rows.map((r) => [String(r._id), r.pending]));
}

/**
 * One page of a product's movement history, newest first (ties by id), with the
 * fields the admin history shows. `meta.total` counts every movement of the product.
 *
 * @param {string} productId
 * @param {{page: number, limit: number}} paging
 * @returns {Promise<{data: object[], meta: object}>}
 */
async function listMovementsOfProduct(productId, { page, limit }) {
	const filter = { productId };
	const { skip, take } = toSkipTake(page, limit);
	const [rows, total] = await Promise.all([
		StockMovement.find(filter)
			.sort({ createdAt: -1, _id: -1 })
			.skip(skip)
			.limit(take)
			.select('type delta target stockAfter status reason createdBy orderId createdAt appliedAt')
			.lean(),
		StockMovement.countDocuments(filter)
	]);
	return {
		data: rows.map((row) => ({ ...row, _id: String(row._id), ...(row.orderId && { orderId: String(row.orderId) }) })),
		meta: buildPaginationMeta(total, { page, limit })
	};
}

module.exports = {
	MOVEMENT_TYPES,
	findMovementByKey,
	createMovement,
	claimForApply,
	applyClaimed,
	recordApplyFailure,
	listPendingIdsCreatedBefore,
	summarizePending,
	readLedgerState,
	readOpeningBasis,
	countPendingByProduct,
	listMovementsOfProduct
};
