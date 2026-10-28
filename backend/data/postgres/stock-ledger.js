/**
 * Stock-ledger storage on Postgres: StockMovement rows and the one write of the
 * Product stock cache. Same functions, arguments and plain records as
 * data/mongo/stock-ledger.js.
 *
 * `applyClaimed` is the only function in the code base that changes
 * `products.stock_quantity` or `product_variants.stock_quantity` after the row
 * exists. A movement belongs to one variant; applying it moves that variant and
 * its product by the same delta, so a product's stock stays the sum of its
 * variants'.
 *
 * Lock order, always: movement row (FOR UPDATE), then variant row (FOR NO KEY
 * UPDATE), then product row (FOR NO KEY UPDATE). Order and order-edit paths only
 * INSERT movements and never lock a product or variant, so no path can hold
 * either and wait for a movement. A new code path that locks a product must not
 * then lock a variant or a movement.
 *
 * Why the locks, at Read Committed:
 * - Movement lock: a second run of the same movement blocks until the first
 *   commits, re-evaluates `status = 'pending'`, finds it applied and does nothing.
 * - Variant and product locks: serialise appliers of one variant and of one
 *   product, so both caches move by the same deltas in the same order, and make
 *   the stock a `set_target` reads the stock it then adjusts. They are NO KEY
 *   UPDATE, not UPDATE: only `stock_quantity` changes, and FOR UPDATE would also
 *   block the KEY SHARE lock that inserts referencing the row take (order lines
 *   and movements reference neither by foreign key today, but the product's
 *   options and variants reference the product). Appliers still exclude each
 *   other, since NO KEY UPDATE conflicts with itself.
 * - The `updateMany` count of 1 is defence in depth behind the movement lock and
 *   the `status = 'pending'` predicate of the gate: either of those alone already
 *   stops a second run, so the check is kept for the day one of them is edited
 *   away, not because a test can observe it alone.
 *
 * Ids are uuid strings. A value that is not a uuid is refused with
 * `InvalidIdError` before it reaches a query.
 */
const { prisma } = require('../../lib/prisma');
const { MovementType } = require('../../generated/prisma/client');
const { normalizeRecordId } = require('../ids');
const { translating } = require('./errors');
const { withTransaction } = require('./tx');
const { toSkipTake, buildPaginationMeta } = require('@sab/shared');
const { v7: uuidv7 } = require('uuid');

// The database enum is the one list of movement types.
const MOVEMENT_TYPES = Object.values(MovementType);

const ERROR_TEXT_LENGTH = 500;

/** A stored movement as a plain record: `_id` and the referenced ids are strings. `seq` is internal ordering and never leaves. */
function toRecord(row) {
	const { id, seq: _seq, ...rest } = row;
	return { _id: id, ...rest };
}

const clientOf = (tx) => tx || prisma;

/**
 * The movement with this idempotency key, or null.
 *
 * @param {string} idempotencyKey
 * @param {object|null} [tx]
 * @returns {Promise<object|null>}
 */
async function findMovementByKey(idempotencyKey, tx) {
	const row = await clientOf(tx).stockMovement.findUnique({ where: { idempotencyKey } });
	return row ? toRecord(row) : null;
}

/**
 * The variant a movement that names none belongs to: the product's default
 * variant (no option values). A product that is gone gets a fresh id, which no
 * variant has, so the worker settles the movement as it settles any movement of
 * deleted stock (an order line of a deleted product names no variant either).
 *
 * @throws {Error} the product exists but has options: its movements must name a variant
 */
async function defaultVariantIdOf(productId, tx) {
	const db = clientOf(tx);
	const variant = await db.productVariant.findFirst({ where: { productId, optionValues: { equals: [] } }, select: { id: true } });
	if (variant) return variant.id;
	if (await db.product.findUnique({ where: { id: productId }, select: { id: true } })) {
		throw new Error(`Product ${productId} has options; a stock movement must name its variant`);
	}
	return uuidv7();
}

/**
 * Insert one movement and return it.
 *
 * A taken idempotency key rejects with a `DuplicateKeyError` naming
 * `idempotencyKey`. Inside a transaction Postgres has then aborted it, so the
 * caller reruns the transaction rather than carrying on.
 *
 * @param {object} record fields of the movement, `status`/`appliedAt`/`stockAfter` only for an already-applied one
 * @param {object|null} [tx]
 * @returns {Promise<object>}
 */
function createMovement(record, tx) {
	return translating(async () => {
		// A legacy hex id from the API or an old job maps to the row's uuid.
		const productId = normalizeRecordId(record.productId);
		const variantId = record.variantId == null ? await defaultVariantIdOf(productId, tx) : normalizeRecordId(record.variantId);
		const row = await clientOf(tx).stockMovement.create({
			data: {
				productId,
				variantId,
				type: record.type,
				delta: record.delta ?? null,
				target: record.target ?? null,
				orderId: record.orderId == null ? null : normalizeRecordId(record.orderId),
				reason: record.reason,
				createdBy: record.createdBy,
				idempotencyKey: record.idempotencyKey,
				status: record.status,
				appliedAt: record.appliedAt,
				stockAfter: record.stockAfter
			}
		});
		return toRecord(row);
	});
}

/**
 * Movements of the same product apply in `seq` order. `seq` is drawn at insert,
 * not at commit, so the guarantee is insertion order among COMMITTED rows: a
 * lower `seq` whose transaction commits later is invisible here (the same gap
 * Mongo's createdAt ordering has). The mitigation is the sweeper, which only
 * picks movements older than an age threshold (`listPendingIdsCreatedBefore`),
 * by which time such a straggler has committed.
 */
async function hasOlderPending(movement) {
	const older = await prisma.stockMovement.findFirst({
		where: { productId: movement.productId, status: 'pending', seq: { lt: movement.seq } },
		select: { id: true }
	});
	return older !== null;
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
	const id = normalizeRecordId(movementId);
	const movement = await prisma.stockMovement.findUnique({ where: { id } });
	if (!movement || movement.status !== 'pending') return { state: 'missing' };

	if (await hasOlderPending(movement)) return { state: 'deferred' };

	const { count } = await prisma.stockMovement.updateMany({
		where: { id, status: 'pending' },
		data: { claimedAt: new Date(), attempts: { increment: 1 } }
	});
	// Applied by another run between the read and the claim.
	if (count !== 1) return { state: 'missing' };
	return { state: 'claimed', movement: { _id: movement.id, type: movement.type } };
}

/**
 * Flip a pending movement to applied and move the product cache by its delta, in
 * one transaction gated on the movement still being pending, so exactly one run
 * ever counts. Safe to run any number of times, concurrently or after a crash.
 *
 * @param {string} movementId
 * @returns {Promise<boolean>} true when this run applied it
 */
function applyClaimed(movementId) {
	const id = normalizeRecordId(movementId);
	// withTransaction re-runs the callback on a deadlock, so it re-reads everything.
	return withTransaction(async (tx) => {
		const [movement] = await tx.$queryRaw`
			SELECT id, product_id, variant_id, type::text AS type, delta, target
			FROM stock_movements
			WHERE id = ${id}::uuid AND status = 'pending'
			FOR UPDATE`;
		if (!movement) return false;

		const [variant] = await tx.$queryRaw`
			SELECT stock_quantity FROM product_variants
			WHERE id = ${movement.variant_id}::uuid AND product_id = ${movement.product_id}::uuid FOR NO KEY UPDATE`;
		const [product] = await tx.$queryRaw`
			SELECT stock_quantity FROM products WHERE id = ${movement.product_id}::uuid FOR NO KEY UPDATE`;
		const appliedAt = new Date();

		if (!product || !variant) {
			// The product (or this variant of it) was deleted. Leaving the movement
			// pending would block the queue for stock that no longer exists.
			const { count } = await tx.stockMovement.updateMany({
				where: { id, status: 'pending' },
				data: { status: 'applied', appliedAt, delta: movement.delta ?? 0, lastError: product ? 'VARIANT_NOT_FOUND' : 'PRODUCT_NOT_FOUND' }
			});
			return count === 1;
		}

		// A target is the variant's stock; stock_after records the variant's too.
		const current = variant.stock_quantity;
		const delta = movement.type === 'set_target' ? movement.target - current : movement.delta;

		// The gate: only the run that flips this movement goes on to touch the product.
		const gate = await tx.stockMovement.updateMany({
			where: { id, status: 'pending' },
			data: { status: 'applied', appliedAt, delta, stockAfter: current + delta, lastError: null }
		});
		if (gate.count !== 1) return false;

		if (delta !== 0) {
			await tx.productVariant.update({ where: { id: movement.variant_id }, data: { stockQuantity: { increment: delta } } });
			await tx.product.update({ where: { id: movement.product_id }, data: { stockQuantity: { increment: delta } } });
		}
		return true;
	});
}

/**
 * Store the failure text on a movement that is still pending.
 *
 * @param {string} movementId
 * @param {string} errorText cut to 500 characters
 * @returns {Promise<{attempts: number, productId: string}|null>} null when the movement is no longer pending
 */
async function recordApplyFailure(movementId, errorText) {
	const id = normalizeRecordId(movementId);
	const { count } = await prisma.stockMovement.updateMany({
		where: { id, status: 'pending' },
		data: { lastError: errorText.slice(0, ERROR_TEXT_LENGTH) }
	});
	if (count !== 1) return null;
	const failed = await prisma.stockMovement.findUnique({ where: { id }, select: { attempts: true, productId: true } });
	return failed ? { attempts: failed.attempts, productId: failed.productId } : null;
}

/**
 * Ids of pending movements created before `createdBefore`, oldest first.
 *
 * @param {{createdBefore: Date, limit: number}} scan
 * @returns {Promise<string[]>}
 */
async function listPendingIdsCreatedBefore({ createdBefore, limit }) {
	// seq is the pending_by_age index order; createdAt only trims the tail.
	const stale = await prisma.stockMovement.findMany({
		where: { status: 'pending', createdAt: { lt: createdBefore } },
		orderBy: { seq: 'asc' },
		take: limit,
		select: { id: true }
	});
	return stale.map((m) => m.id);
}

/**
 * How many movements are pending and when the oldest was created.
 *
 * @returns {Promise<{count: number, oldestCreatedAt: Date|null}>}
 */
async function summarizePending() {
	const [count, oldest] = await Promise.all([
		prisma.stockMovement.count({ where: { status: 'pending' } }),
		prisma.stockMovement.findFirst({ where: { status: 'pending' }, orderBy: { seq: 'asc' }, select: { createdAt: true } })
	]);
	return { count, oldestCreatedAt: oldest ? oldest.createdAt : null };
}

/**
 * What reconcile compares: the sum of applied deltas and the pending count per
 * product (keyed by id string), and every product's cached stock.
 *
 * With a `tx` the reads run inside it one after another (a transaction runs one
 * operation at a time) and see what the transaction has written. They are
 * separate statements at Read Committed, so this is NOT one snapshot: an apply
 * that commits in between can make a product look briefly inconsistent. Fine for
 * a diagnostic; do not derive a baseline from it (see `readOpeningBasis`).
 *
 * @param {object|null} [tx]
 * @returns {Promise<{appliedSumByProduct: Map<string, number>, pendingByProduct: Map<string, number>,
 *                    products: Array<{productId: string, name: string, stockQuantity?: number}>}>}
 */
async function readLedgerState(tx) {
	const db = clientOf(tx);
	const sums = await db.stockMovement.groupBy({ by: ['productId'], where: { status: 'applied' }, _sum: { delta: true } });
	const pendingCounts = await db.stockMovement.groupBy({ by: ['productId'], where: { status: 'pending' }, _count: { _all: true } });
	const products = await db.product.findMany({ select: { id: true, name: true, stockQuantity: true } });
	return {
		appliedSumByProduct: new Map(sums.map((s) => [s.productId, Number(s._sum.delta ?? 0)])),
		pendingByProduct: new Map(pendingCounts.map((p) => [p.productId, p._count._all])),
		products: products.map((p) => ({ productId: p.id, name: p.name, stockQuantity: p.stockQuantity }))
	};
}

/**
 * What an opening baseline needs for one product: its cached stock and the sum of
 * its applied movements. Null when the product does not exist.
 *
 * Read Committed gives each statement its own snapshot, so the two reads would
 * drift if an apply committed between them. The product row is locked first
 * (FOR NO KEY UPDATE, the lock an apply takes): any apply either committed
 * before the lock was granted, and both reads see it, or waits until `tx` ends.
 *
 * @param {string} productId
 * @param {object} tx
 * @returns {Promise<{stockQuantity: number, appliedSum: number}|null>}
 */
async function readOpeningBasis(productId, tx) {
	const id = normalizeRecordId(productId);
	const [product] = await tx.$queryRaw`SELECT stock_quantity FROM products WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
	if (!product) return null;
	const { _sum } = await tx.stockMovement.aggregate({ where: { productId: id, status: 'applied' }, _sum: { delta: true } });
	return { stockQuantity: product.stock_quantity, appliedSum: Number(_sum.delta ?? 0) };
}

/**
 * Number of pending movements per product.
 *
 * @param {Array<string|object>} productIds
 * @returns {Promise<Map<string, number>>}
 */
async function countPendingByProduct(productIds) {
	const ids = productIds.map((id) => normalizeRecordId(id));
	const rows = await prisma.stockMovement.groupBy({
		by: ['productId'],
		where: { productId: { in: ids }, status: 'pending' },
		_count: { _all: true }
	});
	return new Map(rows.map((r) => [r.productId, r._count._all]));
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
	const where = { productId: normalizeRecordId(productId) };
	const { skip, take } = toSkipTake(page, limit);
	const [rows, total] = await Promise.all([
		prisma.stockMovement.findMany({
			where,
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			skip,
			take,
			select: {
				id: true, type: true, delta: true, target: true, stockAfter: true, status: true,
				reason: true, createdBy: true, orderId: true, createdAt: true, appliedAt: true
			}
		}),
		prisma.stockMovement.count({ where })
	]);
	return {
		data: rows.map(({ id, ...rest }) => ({ _id: id, ...rest })),
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
