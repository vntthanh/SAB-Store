/**
 * The stock-ledger contract, run against whichever backend DATA_BACKEND selects
 * (postgres by default; `pnpm test:contract:mongo` runs it on the rollback store). Every
 * assertion re-reads the database through tests/helpers/db.js, so a backend that
 * returns the right values but stores the wrong ones fails here.
 */
const data = require('../../data');
const ledger = require('../../services/stock-ledger');
const ErrorLogger = require('../../utils/errorLogger');
const { isDuplicateKeyOn, isDuplicateKeyError } = require('../../data/errors');
const {
	newId, findMovement, movements, countRows, insertRawProduct, patchProduct, patchMovement, deleteProduct,
	withTransaction, txOptions, failNextStockWrite, stockOf,
} = require('../helpers/db');

const { recordMovement, applyMovement, reconcile, recordAppliedOpening, countPendingByProduct } = ledger;
const { stockLedger } = data;

const POSTGRES = process.env.DATA_BACKEND === 'postgres';

afterAll(async () => {
	if (POSTGRES) await require('../../lib/prisma').closeDb();
});

let sequence = 0;
const nextKey = () => `contract-key-${++sequence}`;

const makeProduct = (stockQuantity = 0) => insertRawProduct({ name: `Contract Product ${++sequence}`, price: 1000, category: 'general', stockQuantity });
const adjust = (productId, delta, extra = {}) => recordMovement({ productId, type: 'adjust', delta, idempotencyKey: nextKey(), ...extra });

/** Apply the way the worker does: a deferred movement is retried until its turn comes. */
async function applyUntilDone(movementId, { maxRounds = 400 } = {}) {
	for (let round = 0; round < maxRounds; round++) {
		const result = await applyMovement(movementId);
		if (!result.deferred) return result;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('movement stayed deferred');
}

describe('recordMovement', () => {
	it('returns the stored movement for a repeated idempotency key and stores one row', async () => {
		const product = await makeProduct();

		const first = await adjust(product._id, 5, { idempotencyKey: 'same-key' });
		const second = await adjust(product._id, 5, { idempotencyKey: 'same-key' });

		expect(second._id).toBe(first._id);
		expect(await countRows('movement', { idempotencyKey: 'same-key' })).toBe(1);
	});

	it('is idempotent inside one transaction too, and rolls back with it', async () => {
		const product = await makeProduct();

		const ids = await withTransaction(async (tx) => {
			const first = await adjust(product._id, 5, { idempotencyKey: 'tx-key', ...txOptions(tx) });
			const second = await recordMovement({ productId: product._id, type: 'adjust', delta: 5, idempotencyKey: 'tx-key' }, txOptions(tx));
			return [first._id, second._id];
		});
		expect(ids[1]).toBe(ids[0]);
		expect(await countRows('movement', { idempotencyKey: 'tx-key' })).toBe(1);

		await expect(withTransaction(async (tx) => {
			await recordMovement({ productId: product._id, type: 'adjust', delta: 9, idempotencyKey: 'tx-rolled-back' }, txOptions(tx));
			throw new Error('order failed halfway');
		})).rejects.toThrow('order failed halfway');
		expect(await countRows('movement', { idempotencyKey: 'tx-rolled-back' })).toBe(0);
	});

	it('records one row when two callers race on the same key', async () => {
		const product = await makeProduct();

		const [first, second] = await Promise.all([
			adjust(product._id, 5, { idempotencyKey: 'racing-key' }),
			adjust(product._id, 5, { idempotencyKey: 'racing-key' }),
		]);

		expect(second._id).toBe(first._id);
		expect(await countRows('movement', { idempotencyKey: 'racing-key' })).toBe(1);
	});

	it('raises a duplicate-key error naming idempotencyKey when the repository is asked to insert a taken key', async () => {
		const product = await makeProduct();
		await adjust(product._id, 1, { idempotencyKey: 'taken' });

		const error = await stockLedger.createMovement({ productId: product._id, type: 'adjust', delta: 1, reason: '', createdBy: '', idempotencyKey: 'taken' }).catch((e) => e);

		expect(isDuplicateKeyError(error)).toBe(true);
		expect(isDuplicateKeyOn(error, 'idempotencyKey')).toBe(true);
	});

	it('stores set_target with a null delta and a pending status, as plain records', async () => {
		const product = await makeProduct(7);

		const movement = await recordMovement({ productId: product._id, type: 'set_target', target: 3, idempotencyKey: nextKey() });

		expect(typeof movement._id).toBe('string');
		expect(movement).toMatchObject({ productId: product._id, type: 'set_target', target: 3, delta: null, status: 'pending', attempts: 0 });
		expect(await findMovement(movement._id)).toMatchObject({ target: 3, delta: null, appliedAt: null, stockAfter: null });
		expect(await stockOf(product._id)).toBe(7);
	});

	it('records an already-applied opening movement once without touching the product', async () => {
		const product = await makeProduct(4);

		const first = await recordAppliedOpening({ productId: product._id, quantity: 4 });
		const second = await recordAppliedOpening({ productId: product._id, quantity: 4 });

		expect(second._id).toBe(first._id);
		expect(await findMovement(first._id)).toMatchObject({ type: 'opening', status: 'applied', delta: 4, stockAfter: 4 });
		expect(await countRows('movement')).toBe(1);
	});
});

describe('applyMovement', () => {
	it('applies exactly once when the same movement is applied by many runs at the same time', async () => {
		const product = await makeProduct(0);
		const movement = await adjust(product._id, 5);

		const results = await Promise.all(Array.from({ length: 8 }, () => applyMovement(movement._id)));

		expect(results.filter((r) => r.applied)).toHaveLength(1);
		expect(await stockOf(product._id)).toBe(5);
		expect(await findMovement(movement._id)).toMatchObject({ status: 'applied', delta: 5, stockAfter: 5 });
		expect(await movements({ productId: product._id, status: 'applied' })).toHaveLength(1);
	});

	it('applies an already-applied movement as a no-op and ignores a movement that does not exist', async () => {
		const product = await makeProduct(0);
		const movement = await adjust(product._id, 4);
		await applyMovement(movement._id);

		expect(await applyMovement(movement._id)).toEqual({ applied: false, deferred: false });
		expect(await applyMovement(newId())).toEqual({ applied: false, deferred: false });
		expect(await stockOf(product._id)).toBe(4);
	});

	it('refuses an id of the wrong shape instead of matching nothing', async () => {
		await expect(applyMovement('not-an-id')).rejects.toBeDefined();
	});

	it('defers a movement while an older one of the same product is pending, and applies both in order', async () => {
		const product = await makeProduct(10);
		const older = await adjust(product._id, 5);
		const younger = await adjust(product._id, -2);

		expect(await applyMovement(younger._id)).toEqual({ applied: false, deferred: true });
		expect(await stockOf(product._id)).toBe(10);
		expect(await findMovement(younger._id)).toMatchObject({ status: 'pending', attempts: 0 });

		expect((await applyMovement(older._id)).applied).toBe(true);
		expect((await applyMovement(younger._id)).applied).toBe(true);
		expect(await stockOf(product._id)).toBe(13);
	});

	it('does not defer a movement behind an older one of another product', async () => {
		const [a, b] = [await makeProduct(0), await makeProduct(0)];
		await adjust(a._id, 1);
		const other = await adjust(b._id, 2);

		expect((await applyMovement(other._id)).applied).toBe(true);
		expect(await stockOf(b._id)).toBe(2);
	});

	it('computes a set_target delta from the stock at apply time', async () => {
		const product = await makeProduct(10);
		const bump = await adjust(product._id, 5);
		const target = await recordMovement({ productId: product._id, type: 'set_target', target: 3, idempotencyKey: nextKey() });

		await applyMovement(bump._id);
		// Stock changed behind the ledger's back after the target was recorded. On
		// postgres a target is the variant's stock, so the default variant moves too.
		await patchProduct(product._id, { stockQuantity: 20 });
		if (POSTGRES) await require('../../lib/prisma').prisma.productVariant.updateMany({ where: { productId: product._id }, data: { stockQuantity: 20 } });
		await applyMovement(target._id);

		expect(await stockOf(product._id)).toBe(3);
		expect(await findMovement(target._id)).toMatchObject({ status: 'applied', delta: -17, target: 3, stockAfter: 3 });
	});

	it('marks a movement applied with PRODUCT_NOT_FOUND when its product was deleted, so it cannot block the queue', async () => {
		const product = await makeProduct(5);
		const movement = await adjust(product._id, 1);
		const target = await recordMovement({ productId: product._id, type: 'set_target', target: 2, idempotencyKey: nextKey() });
		await deleteProduct(product._id);

		expect((await applyUntilDone(movement._id)).applied).toBe(true);
		expect((await applyUntilDone(target._id)).applied).toBe(true);

		expect(await findMovement(movement._id)).toMatchObject({ status: 'applied', delta: 1, lastError: 'PRODUCT_NOT_FOUND' });
		expect(await findMovement(target._id)).toMatchObject({ status: 'applied', delta: 0, lastError: 'PRODUCT_NOT_FOUND' });
		expect(await stockOf(product._id)).toBeNull();
	});

	it('lets stock go negative', async () => {
		const product = await makeProduct(1);
		const movement = await recordMovement({ productId: product._id, type: 'order', delta: -3, idempotencyKey: nextKey() });

		await applyMovement(movement._id);

		expect(await stockOf(product._id)).toBe(-2);
		expect(await findMovement(movement._id)).toMatchObject({ stockAfter: -2 });
	});
});

describe('failure counting', () => {
	it('counts one attempt per claim and keeps counting while the movement stays pending', async () => {
		const product = await makeProduct();
		const movement = await adjust(product._id, 1);

		expect(await stockLedger.claimForApply(movement._id)).toEqual({ state: 'claimed', movement: { _id: movement._id, type: 'adjust' } });
		await stockLedger.claimForApply(movement._id);

		expect(await findMovement(movement._id)).toMatchObject({ status: 'pending', attempts: 2 });
		expect((await findMovement(movement._id)).claimedAt).toBeInstanceOf(Date);
	});

	it('stores the failure text cut to 500 characters and reports the attempts, but only while pending', async () => {
		const product = await makeProduct();
		const movement = await adjust(product._id, 1);
		await stockLedger.claimForApply(movement._id);

		const failed = await stockLedger.recordApplyFailure(movement._id, 'x'.repeat(600));

		expect(failed).toEqual({ attempts: 1, productId: product._id });
		expect((await findMovement(movement._id)).lastError).toBe('x'.repeat(500));

		await applyMovement(movement._id);
		expect(await stockLedger.recordApplyFailure(movement._id, 'late')).toBeNull();
		expect(await stockLedger.recordApplyFailure(newId(), 'unknown')).toBeNull();
	});

	it('rolls the whole apply back when the cache write fails, records the failure and succeeds on retry', async () => {
		const product = await makeProduct(10);
		const movement = await adjust(product._id, 5);

		const fault = failNextStockWrite('disk on fire');
		try {
			await expect(applyMovement(movement._id)).rejects.toThrow('disk on fire');
			expect(fault.fired()).toBe(true);
		} finally {
			fault.remove();
		}

		expect(await findMovement(movement._id)).toMatchObject({ status: 'pending', stockAfter: null, attempts: 1, appliedAt: null });
		expect((await findMovement(movement._id)).lastError).toContain('disk on fire');
		expect(await stockOf(product._id)).toBe(10);

		expect((await applyMovement(movement._id)).applied).toBe(true);
		expect(await stockOf(product._id)).toBe(15);
	});

	it('logs a critical error only once the attempts reach the threshold', async () => {
		const product = await makeProduct(0);
		const movement = await adjust(product._id, 1);
		const critical = vi.spyOn(ErrorLogger, 'logCritical').mockImplementation(() => {});

		try {
			await patchMovement(movement._id, { attempts: ledger.CRITICAL_AFTER_ATTEMPTS - 2 });
			let fault = failNextStockWrite('below threshold');
			await expect(applyMovement(movement._id)).rejects.toThrow('below threshold');
			fault.remove();
			expect(critical).not.toHaveBeenCalled();

			fault = failNextStockWrite('at threshold');
			await expect(applyMovement(movement._id)).rejects.toThrow('at threshold');
			fault.remove();
			expect(critical).toHaveBeenCalledTimes(1);
			expect(critical.mock.calls[0][2]).toMatchObject({ movementId: movement._id, productId: product._id, attempts: ledger.CRITICAL_AFTER_ATTEMPTS });
		} finally {
			critical.mockRestore();
		}
	});
});

describe('ledger reads', () => {
	it('reconcile lists only the products whose cache differs from the applied movements', async () => {
		const consistent = await makeProduct(0);
		const tampered = await makeProduct(0);
		const pendingOnly = await makeProduct(0);
		for (const p of [consistent, tampered]) await applyMovement((await adjust(p._id, 3))._id);
		await adjust(pendingOnly._id, 2);
		await patchProduct(tampered._id, { stockQuantity: 99 });

		const found = await reconcile();

		expect(found).toEqual([{ productId: tampered._id, name: tampered.name, cached: 99, ledgerSum: 3, diff: 96, pending: 0 }]);
	});

	it('reconcile inside a transaction sees what the transaction wrote', async () => {
		const product = await makeProduct(5);

		const inside = await withTransaction(async (tx) => {
			await recordAppliedOpening({ productId: product._id, quantity: 2, stockAfter: 5 }, txOptions(tx));
			return reconcile({ tx });
		});

		expect(inside).toEqual([expect.objectContaining({ productId: product._id, cached: 5, ledgerSum: 2, diff: 3 })]);
	});

	it('readLedgerState returns plain numbers keyed by id string, safe to serialise', async () => {
		const product = await makeProduct(0);
		const empty = await makeProduct(0);
		await applyMovement((await adjust(product._id, 3))._id);
		await applyMovement((await adjust(product._id, -1))._id);
		await adjust(product._id, 4);

		const state = await stockLedger.readLedgerState();

		expect(state.appliedSumByProduct.get(product._id)).toBe(2);
		expect(state.pendingByProduct.get(product._id)).toBe(1);
		expect(state.appliedSumByProduct.has(empty._id)).toBe(false);
		expect(state.products).toEqual(expect.arrayContaining([{ productId: product._id, name: product.name, stockQuantity: 2 }]));
		expect(() => JSON.stringify([...state.appliedSumByProduct, ...state.pendingByProduct])).not.toThrow();
		for (const value of [...state.appliedSumByProduct.values(), ...state.pendingByProduct.values()]) expect(typeof value).toBe('number');
	});

	it('countPendingByProduct counts pending movements per requested product only', async () => {
		const [a, b, c] = [await makeProduct(), await makeProduct(), await makeProduct()];
		await adjust(a._id, 1);
		await adjust(a._id, 1);
		await applyMovement((await adjust(b._id, 1))._id);
		await adjust(c._id, 1);

		const counts = await countPendingByProduct([a._id, b._id]);

		expect([...counts.entries()]).toEqual([[a._id, 2]]);
		expect((await countPendingByProduct([])).size).toBe(0);
	});

	it('readOpeningBasis returns the cached stock and the applied sum, and null for a missing product', async () => {
		const product = await makeProduct(0);
		await applyMovement((await adjust(product._id, 6))._id);
		await adjust(product._id, 100);

		const basis = await withTransaction((tx) => stockLedger.readOpeningBasis(product._id, tx));
		const missing = await withTransaction((tx) => stockLedger.readOpeningBasis(newId(), tx));

		expect(basis).toEqual({ stockQuantity: 6, appliedSum: 6 });
		expect(missing).toBeNull();
	});

	it('lists pending ids oldest first below the cutoff, with a limit, and summarises the backlog', async () => {
		const product = await makeProduct();
		const none = await stockLedger.summarizePending();
		const first = await adjust(product._id, 1);
		const second = await adjust(product._id, 1);
		const third = await adjust(product._id, 1);
		await applyMovement(first._id);

		const future = new Date(Date.now() + 60000);
		const ids = await stockLedger.listPendingIdsCreatedBefore({ createdBefore: future, limit: 10 });
		const limited = await stockLedger.listPendingIdsCreatedBefore({ createdBefore: future, limit: 1 });
		const tooEarly = await stockLedger.listPendingIdsCreatedBefore({ createdBefore: new Date(Date.now() - 60000), limit: 10 });
		const summary = await stockLedger.summarizePending();

		expect(none).toEqual({ count: 0, oldestCreatedAt: null });
		expect(ids).toEqual([second._id, third._id]);
		expect(limited).toEqual([second._id]);
		expect(tooEarly).toEqual([]);
		expect(summary.count).toBe(2);
		expect(summary.oldestCreatedAt).toBeInstanceOf(Date);
	});

	it('pages a product history newest first with the shared envelope', async () => {
		const product = await makeProduct();
		const other = await makeProduct();
		const created = [];
		for (let i = 0; i < 5; i++) created.push(await adjust(product._id, i + 1));
		await adjust(other._id, 1);

		const page = await stockLedger.listMovementsOfProduct(product._id, { page: 2, limit: 2 });

		expect(page.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
		expect(page.data.map((row) => row._id)).toEqual([created[2]._id, created[1]._id]);
		expect(page.data[0]).toMatchObject({ type: 'adjust', delta: 3, status: 'pending', orderId: null });
		expect(Object.keys(page.data[0]).sort()).toEqual(
			['_id', 'appliedAt', 'createdAt', 'createdBy', 'delta', 'orderId', 'reason', 'status', 'stockAfter', 'target', 'type']
		);
	});
});

describe('concurrency', () => {
	it('leaves the stock exactly right after many movements of one product are applied by overlapping runs', async () => {
		const COUNT = 60;
		const product = await makeProduct(0);
		const created = [];
		const runningTotals = [];
		let expected = 0;
		for (let i = 0; i < COUNT; i++) {
			const delta = ((i % 7) + 1) * (i % 2 === 0 ? 1 : -1);
			created.push(await adjust(product._id, delta));
			expected += delta;
			runningTotals.push(expected);
		}
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		try {
			// Two overlapping runs per movement, as duplicate queue jobs would be.
			const results = await Promise.all(created.flatMap((m) => [applyUntilDone(m._id), applyUntilDone(m._id)]));

			expect(results.filter((r) => r.applied)).toHaveLength(COUNT);
			expect(log.mock.calls.filter(([line]) => String(line).includes('db.tx.retry'))).toEqual([]);
		} finally {
			log.mockRestore();
		}

		expect(await stockOf(product._id)).toBe(expected);
		expect(await countRows('movement', { productId: product._id, status: 'applied' })).toBe(COUNT);
		expect(await countRows('movement', { productId: product._id, status: 'pending' })).toBe(0);
		expect(await reconcile()).toEqual([]);
		// Movements of a product apply in creation order, so each left the running total behind it.
		const stored = await movements({ productId: product._id });
		expect(stored.map((m) => m.stockAfter)).toEqual(runningTotals);
	});
});
