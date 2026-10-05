/**
 * Stock ledger.
 *
 * `Product.stockQuantity` is a cache of the sum of its `applied` StockMovements;
 * the movements are the source of truth. Nothing outside `applyMovement` writes
 * the cache, so every change leaves a trail and the cache can be re-derived
 * (`reconcile`) instead of trusted.
 *
 * Flow: a caller `recordMovement`s inside its own transaction (an order and its
 * movements commit together), calls `enqueueMovements` after the commit, and a
 * queue worker runs `applyMovement`. Redis only dispatches: if it is down or
 * loses a job the movement is still `pending` in MongoDB and the sweeper in
 * queues/stock-queue.js re-enqueues it.
 *
 * Stock may go negative on purpose: an order is never refused for lack of stock.
 */
const mongoose = require('mongoose');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const ErrorLogger = require('../utils/errorLogger');
const { logEvent } = require('../utils/log-event');

const { MOVEMENT_TYPES } = StockMovement;

// Failed apply attempts after which the failure is logged as critical. The
// movement stays pending and keeps being retried; the log is the alarm.
const CRITICAL_AFTER_ATTEMPTS = 5;

const MAX_TEXT_LENGTH = 200;

// Error text in the event line stays short: it is a signal to alert on, the full
// message is on the movement's lastError.
const EVENT_ERROR_LENGTH = 200;

class StockLedgerError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = 'StockLedgerError';
		this.code = 'INVALID_MOVEMENT';
	}
}

// Expected sign of `delta` per type. An `opening` is a baseline, so any value
// is allowed: it may be zero (no stock) or negative (see the backfill script).
const DELTA_RULES = {
	opening: () => true,
	order: (d) => d < 0,
	order_cancel: (d) => d > 0,
	// An edit moves units either way between products, so only a zero delta is meaningless.
	order_edit: (d) => d !== 0,
	adjust: (d) => d !== 0
};

function validateMovement({ productId, type, delta, target, idempotencyKey, reason, createdBy }) {
	if (!mongoose.isValidObjectId(productId)) throw new StockLedgerError('productId is not a valid id');
	if (!MOVEMENT_TYPES.includes(type)) throw new StockLedgerError(`unknown movement type: ${String(type)}`);
	if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > MAX_TEXT_LENGTH) {
		throw new StockLedgerError('idempotencyKey must be a non-empty string of at most 200 characters');
	}
	for (const [name, value] of [['reason', reason], ['createdBy', createdBy]]) {
		if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH)) {
			throw new StockLedgerError(`${name} must be a string of at most 200 characters`);
		}
	}

	if (type === 'set_target') {
		if (!Number.isSafeInteger(target) || target < 0) throw new StockLedgerError('set_target needs a non-negative integer target');
		if (delta !== undefined && delta !== null) throw new StockLedgerError('set_target must not carry a delta; it is computed when applied');
		return;
	}
	if (!Number.isSafeInteger(delta) || !DELTA_RULES[type](delta)) {
		throw new StockLedgerError(`${type} needs an integer delta with the right sign; got ${String(delta)}`);
	}
}

/**
 * Insert a pending movement. Call it INSIDE the transaction of whatever causes
 * the change; it never touches the Product.
 *
 * Idempotent on `idempotencyKey`: a repeated key returns the movement already
 * stored instead of recording a second one.
 *
 * @param {{productId, type, delta?, target?, orderId?, reason?, createdBy?, idempotencyKey}} movement
 * @param {{session?: import('mongoose').ClientSession|null}} [opts]
 * @returns {Promise<import('mongoose').Document>}
 */
async function recordMovement(movement, opts = {}) {
	const session = opts.session || null;
	validateMovement(movement);

	const existing = await findByKey(movement.idempotencyKey, session);
	if (existing) return existing;

	try {
		const [created] = await StockMovement.create([buildDocument(movement)], session ? { session } : undefined);
		return created;
	} catch (err) {
		// Inside a transaction a duplicate-key error has already aborted it, so
		// the caller has to see the error and retry from the top, where the
		// lookup above finds the winner. Outside one, the winner can be returned.
		if (!session && err && err.code === 11000) {
			const winner = await findByKey(movement.idempotencyKey, null);
			if (winner) return winner;
		}
		throw err;
	}
}

function findByKey(idempotencyKey, session) {
	const query = StockMovement.findOne({ idempotencyKey });
	return session ? query.session(session) : query;
}

function buildDocument({ productId, type, delta, target, orderId, reason, createdBy, idempotencyKey }) {
	return {
		productId,
		type,
		delta: type === 'set_target' ? null : delta,
		target: type === 'set_target' ? target : null,
		orderId: orderId || null,
		reason: reason || '',
		createdBy: createdBy || '',
		idempotencyKey
	};
}

/**
 * Record an `opening` movement that is already applied, for a product whose
 * stock is established in the same transaction (a new product, or the one-off
 * backfill of existing stock). Does not touch the Product: the caller sets
 * `stockQuantity` to `quantity` itself.
 *
 * `quantity` is the movement's delta; `stockAfter` is the cache value it leaves
 * behind and defaults to `quantity` (a product that starts at nothing).
 *
 * @param {{productId, quantity: number, stockAfter?: number, createdBy?: string, reason?: string}} opening
 * @param {{session?: import('mongoose').ClientSession|null}} [opts]
 */
async function recordAppliedOpening({ productId, quantity, stockAfter = quantity, createdBy, reason }, opts = {}) {
	const session = opts.session || null;
	const idempotencyKey = `opening:${productId}`;
	validateMovement({ productId, type: 'opening', delta: quantity, idempotencyKey, createdBy, reason });

	const existing = await findByKey(idempotencyKey, session);
	if (existing) return existing;

	const now = new Date();
	const [created] = await StockMovement.create([{
		...buildDocument({ productId, type: 'opening', delta: quantity, createdBy, reason, idempotencyKey }),
		status: 'applied',
		appliedAt: now,
		stockAfter
	}], session ? { session } : undefined);
	return created;
}

/**
 * Hand movements to the queue. Call AFTER the recording transaction commits.
 * A queue failure is only logged: the movements are already durable and the
 * sweeper picks them up.
 *
 * @param {Array<string|{_id: *}>} movements ids or movement documents
 */
async function enqueueMovements(movements) {
	const ids = (Array.isArray(movements) ? movements : [movements])
		.filter(Boolean)
		.map((m) => String(m._id || m));
	if (ids.length === 0) return;

	try {
		// Required lazily: the queue module requires this one for its worker.
		await require('../queues/stock-queue').enqueueMovementJobs(ids);
	} catch (err) {
		ErrorLogger.logWarning('Stock movements recorded but not enqueued; the sweeper will retry', {
			count: ids.length,
			error: err.message
		});
	}
}

/** Movements of the same product apply in (createdAt, _id) order. */
function hasOlderPending(movement) {
	return StockMovement.exists({
		productId: movement.productId,
		status: 'pending',
		$or: [
			{ createdAt: { $lt: movement.createdAt } },
			{ createdAt: movement.createdAt, _id: { $lt: movement._id } }
		]
	});
}

/**
 * Apply one movement to the product cache. Called by the queue worker.
 *
 * Safe to run any number of times, concurrently or after a crash: the flip
 * `pending -> applied` and the `$inc` happen in one transaction gated on the
 * movement still being pending, so exactly one run ever counts.
 *
 * Movements of one product apply strictly in creation order, because a
 * `set_target` only means something relative to the movements before it. When an
 * older one is still pending this returns `deferred` and the caller retries later.
 *
 * @param {string|import('mongoose').Types.ObjectId} movementId
 * @returns {Promise<{applied: boolean, deferred: boolean}>}
 */
async function applyMovement(movementId) {
	const movement = await StockMovement.findById(movementId).lean();
	if (!movement || movement.status !== 'pending') return { applied: false, deferred: false };

	if (await hasOlderPending(movement)) return { applied: false, deferred: true };

	await StockMovement.updateOne(
		{ _id: movement._id, status: 'pending' },
		{ $set: { claimedAt: new Date() }, $inc: { attempts: 1 } }
	);

	const startedAt = Date.now();
	try {
		const applied = await applyInTransaction(movement._id);
		if (applied) logEvent('stock.movement.applied', { movementType: movement.type, ms: Date.now() - startedAt });
		return { applied, deferred: false };
	} catch (err) {
		await recordFailure(movement, err);
		throw err;
	}
}

async function applyInTransaction(movementId) {
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

async function recordFailure(movement, err) {
	const movementId = movement._id;
	const errorText = String(err && err.message);
	let failed;
	try {
		failed = await StockMovement.findOneAndUpdate(
			{ _id: movementId, status: 'pending' },
			{ $set: { lastError: errorText.slice(0, 500) } },
			{ new: true }
		).lean();
	} catch (bookkeepingError) {
		// The original error is what matters and is rethrown by the caller. The
		// failure is still reported: a failing database is when it matters most.
		ErrorLogger.logWarning('Could not record stock movement failure', {
			movementId: String(movementId),
			error: bookkeepingError.message
		});
		failed = undefined;
	}
	// null: the movement is no longer pending (applied by a concurrent run), so
	// there is no failure to report.
	if (failed === null) return;

	logEvent('stock.movement.failed', {
		movementType: movement.type,
		attempts: failed ? failed.attempts : null,
		error: errorText.slice(0, EVENT_ERROR_LENGTH)
	});
	if (failed && failed.attempts >= CRITICAL_AFTER_ATTEMPTS) {
		ErrorLogger.logCritical('Stock movement keeps failing to apply', err, {
			movementId: String(movementId),
			productId: String(failed.productId),
			attempts: failed.attempts
		});
	}
}

/**
 * Compare each product's cache with the sum of its applied movements, from the
 * source and without touching the cache. Returns only products that disagree.
 * Pending movements are reported alongside but are not counted on either side.
 *
 * Fix a discrepancy by recording an `adjust` movement, never by writing the cache.
 *
 * @returns {Promise<Array<{productId: string, name: string, cached: number, ledgerSum: number, diff: number, pending: number}>>}
 */
async function reconcile() {
	const [sums, pendingCounts, products] = await Promise.all([
		StockMovement.aggregate([
			{ $match: { status: 'applied' } },
			{ $group: { _id: '$productId', ledgerSum: { $sum: '$delta' } } }
		]),
		StockMovement.aggregate([
			{ $match: { status: 'pending' } },
			{ $group: { _id: '$productId', pending: { $sum: 1 } } }
		]),
		Product.find({}).select('name stockQuantity').lean()
	]);

	const sumById = new Map(sums.map((s) => [String(s._id), s.ledgerSum]));
	const pendingById = new Map(pendingCounts.map((p) => [String(p._id), p.pending]));

	const discrepancies = [];
	for (const product of products) {
		const id = String(product._id);
		const cached = product.stockQuantity || 0;
		const ledgerSum = sumById.get(id) || 0;
		if (cached === ledgerSum) continue;
		discrepancies.push({
			productId: id,
			name: product.name,
			cached,
			ledgerSum,
			diff: cached - ledgerSum,
			pending: pendingById.get(id) || 0
		});
	}
	return discrepancies;
}

/**
 * Number of pending movements per product, for a page of products.
 * @param {Array} productIds
 * @returns {Promise<Map<string, number>>}
 */
async function countPendingByProduct(productIds) {
	if (productIds.length === 0) return new Map();
	const rows = await StockMovement.aggregate([
		{ $match: { productId: { $in: productIds }, status: 'pending' } },
		{ $group: { _id: '$productId', pending: { $sum: 1 } } }
	]);
	return new Map(rows.map((r) => [String(r._id), r.pending]));
}

module.exports = {
	StockLedgerError,
	recordMovement,
	recordAppliedOpening,
	enqueueMovements,
	applyMovement,
	reconcile,
	countPendingByProduct,
	CRITICAL_AFTER_ATTEMPTS
};
