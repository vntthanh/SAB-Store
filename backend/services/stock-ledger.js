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
 * loses a job the movement is still `pending` in the database and the sweeper in
 * queues/stock-queue.js re-enqueues it.
 *
 * Stock may go negative on purpose: an order is never refused for lack of stock.
 */
const { stockLedger: store } = require('../data');
const { isDuplicateKeyError } = require('../data/errors');
const { isRecordId, normalizeRecordId } = require('../data/ids');
const ErrorLogger = require('../utils/errorLogger');
const { logEvent } = require('../utils/log-event');

const { MOVEMENT_TYPES } = store;

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

/**
 * An id as it appears inside an idempotency key. One row has one canonical id
 * (on postgres a legacy hex id and its mapped uuid are the same product), so a
 * key built from the raw input would differ between callers and record the same
 * change twice. A value that is not an id is returned as text for
 * `validateMovement` to refuse with its own error.
 */
function keyIdOf(id) {
	return isRecordId(id) ? normalizeRecordId(id) : String(id);
}

function validateMovement({ productId, type, delta, target, idempotencyKey, reason, createdBy }) {
	if (!isRecordId(productId)) throw new StockLedgerError('productId is not a valid id');
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
 * @param {{tx?: object|null, session?: object|null}} [opts] the transaction; callers may pass it as `tx` or `session`
 * @returns {Promise<object>} the stored movement
 */
async function recordMovement(movement, opts = {}) {
	const tx = opts.tx || opts.session || null;
	validateMovement(movement);

	const existing = await store.findMovementByKey(movement.idempotencyKey, tx);
	if (existing) return existing;

	try {
		return await store.createMovement(buildDocument(movement), tx);
	} catch (err) {
		// Inside a transaction a duplicate-key error has already aborted it, so
		// the caller has to see the error and retry from the top, where the
		// lookup above finds the winner. Outside one, the winner can be returned.
		if (!tx && isDuplicateKeyError(err)) {
			const winner = await store.findMovementByKey(movement.idempotencyKey, null);
			if (winner) return winner;
		}
		throw err;
	}
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
 * @param {{tx?: object|null, session?: object|null}} [opts] the transaction; callers may pass it as `tx` or `session`
 */
async function recordAppliedOpening({ productId, quantity, stockAfter = quantity, createdBy, reason }, opts = {}) {
	const tx = opts.tx || opts.session || null;
	const idempotencyKey = `opening:${keyIdOf(productId)}`;
	validateMovement({ productId, type: 'opening', delta: quantity, idempotencyKey, createdBy, reason });

	const existing = await store.findMovementByKey(idempotencyKey, tx);
	if (existing) return existing;

	return store.createMovement({
		...buildDocument({ productId, type: 'opening', delta: quantity, createdBy, reason, idempotencyKey }),
		status: 'applied',
		appliedAt: new Date(),
		stockAfter
	}, tx);
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

/**
 * Apply one movement to the product cache. Called by the queue worker.
 *
 * Safe to run any number of times, concurrently or after a crash: the flip
 * `pending -> applied` and the cache increment happen in one transaction gated on
 * the movement still being pending, so exactly one run ever counts.
 *
 * Movements of one product apply strictly in creation order, because a
 * `set_target` only means something relative to the movements before it. When an
 * older one is still pending this returns `deferred` and the caller retries later.
 *
 * @param {string} movementId
 * @returns {Promise<{applied: boolean, deferred: boolean}>}
 */
async function applyMovement(movementId) {
	const claim = await store.claimForApply(movementId);
	if (claim.state === 'missing') return { applied: false, deferred: false };
	if (claim.state === 'deferred') return { applied: false, deferred: true };
	const { movement } = claim;

	const startedAt = Date.now();
	try {
		const applied = await store.applyClaimed(movement._id);
		if (applied) logEvent('stock.movement.applied', { movementType: movement.type, ms: Date.now() - startedAt });
		return { applied, deferred: false };
	} catch (err) {
		await recordFailure(movement, err);
		throw err;
	}
}

async function recordFailure(movement, err) {
	const movementId = movement._id;
	const errorText = String(err && err.message);
	let failed;
	try {
		failed = await store.recordApplyFailure(movementId, errorText);
	} catch (bookkeepingError) {
		// The original error is what matters and is rethrown by the caller. The
		// failure is still reported: a failing database is when it matters most.
		ErrorLogger.logWarning('Could not record stock movement failure', {
			movementId,
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
			movementId,
			productId: failed.productId,
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
 * With a `tx` it reads inside that transaction, so a bulk write (a restore) can
 * be checked before it commits.
 *
 * @param {{tx?: object|null}} [opts]
 * @returns {Promise<Array<{productId: string, name: string, cached: number, ledgerSum: number, diff: number, pending: number}>>}
 */
async function reconcile(opts = {}) {
	const { appliedSumByProduct, pendingByProduct, products } = await store.readLedgerState(opts.tx || null);

	const discrepancies = [];
	for (const product of products) {
		const id = product.productId;
		const cached = product.stockQuantity || 0;
		const ledgerSum = appliedSumByProduct.get(id) || 0;
		if (cached === ledgerSum) continue;
		discrepancies.push({
			productId: id,
			name: product.name,
			cached,
			ledgerSum,
			diff: cached - ledgerSum,
			pending: pendingByProduct.get(id) || 0
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
	return store.countPendingByProduct(productIds);
}

module.exports = {
	recordMovement,
	recordAppliedOpening,
	enqueueMovements,
	applyMovement,
	keyIdOf,
	reconcile,
	countPendingByProduct,
	CRITICAL_AFTER_ATTEMPTS
};
