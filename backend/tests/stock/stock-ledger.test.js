/**
 * Stock ledger service against the real database (no queue involved): every
 * assertion re-reads Mongo rather than trusting a return value.
 */
const mongoose = require('mongoose');
const Product = require('../../models/Product');
const StockMovement = require('../../models/StockMovement');
const ledger = require('../../services/stock-ledger');
const { makeProduct } = require('../helpers/factories');

const { recordMovement, applyMovement, reconcile, recordAppliedOpening, enqueueMovements } = ledger;

let keySeq = 0;
const nextKey = () => `test-key-${++keySeq}`;

function adjust(productId, delta, extra = {}) {
	return recordMovement({ productId, type: 'adjust', delta, idempotencyKey: nextKey(), ...extra });
}

const stockOf = async (productId) => (await Product.findById(productId)).stockQuantity;

/** Apply like the worker does: a deferred movement is retried until its turn comes. */
async function applyUntilDone(movementId, { maxRounds = 200 } = {}) {
	for (let round = 0; round < maxRounds; round++) {
		const result = await applyMovement(movementId);
		if (!result.deferred) return result;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error('movement stayed deferred');
}

beforeAll(async () => {
	await StockMovement.init();
});

describe('recordMovement', () => {
	it('inserts a pending movement and does not touch the product', async () => {
		const product = await makeProduct({ stockQuantity: 7 });

		const movement = await recordMovement({
			productId: product._id,
			type: 'order',
			delta: -2,
			orderId: new mongoose.Types.ObjectId(),
			reason: 'web order',
			createdBy: 'system',
			idempotencyKey: 'order:x:y:create'
		});

		const stored = await StockMovement.findById(movement._id).lean();
		expect(stored).toMatchObject({ type: 'order', delta: -2, status: 'pending', appliedAt: null, stockAfter: null, attempts: 0 });
		expect(await stockOf(product._id)).toBe(7);
	});

	it('stores set_target with a null delta until it is applied', async () => {
		const product = await makeProduct({ stockQuantity: 7 });

		const movement = await recordMovement({ productId: product._id, type: 'set_target', target: 3, idempotencyKey: nextKey() });

		const stored = await StockMovement.findById(movement._id).lean();
		expect(stored.target).toBe(3);
		expect(stored.delta).toBeNull();
	});

	it('does not record a second movement for a repeated idempotencyKey', async () => {
		const product = await makeProduct();

		const first = await adjust(product._id, 5, { idempotencyKey: 'same-key' });
		const second = await adjust(product._id, 5, { idempotencyKey: 'same-key' });
		const [third, fourth] = await Promise.all([
			adjust(product._id, 5, { idempotencyKey: 'racing-key' }),
			adjust(product._id, 5, { idempotencyKey: 'racing-key' })
		]);

		expect(String(second._id)).toBe(String(first._id));
		expect(String(fourth._id)).toBe(String(third._id));
		expect(await StockMovement.countDocuments({ idempotencyKey: { $in: ['same-key', 'racing-key'] } })).toBe(2);
	});

	it('inside a transaction, rolls back with the caller', async () => {
		const product = await makeProduct();
		const session = await mongoose.startSession();
		try {
			await expect(session.withTransaction(async () => {
				await recordMovement(
					{ productId: product._id, type: 'adjust', delta: 9, idempotencyKey: 'tx-rolled-back' },
					{ session }
				);
				throw new Error('order failed halfway');
			})).rejects.toThrow('order failed halfway');
		} finally {
			await session.endSession();
		}

		expect(await StockMovement.countDocuments({ idempotencyKey: 'tx-rolled-back' })).toBe(0);
	});

	it.each([
		['unknown type', { type: 'refund', delta: 1 }],
		['order with a positive delta', { type: 'order', delta: 1 }],
		['order_cancel with a negative delta', { type: 'order_cancel', delta: -1 }],
		['adjust of zero', { type: 'adjust', delta: 0 }],
		['fractional delta', { type: 'adjust', delta: 1.5 }],
		['set_target without a target', { type: 'set_target' }],
		['set_target with a negative target', { type: 'set_target', target: -1 }],
		['set_target carrying a delta', { type: 'set_target', target: 1, delta: 1 }],
		['empty idempotencyKey', { type: 'adjust', delta: 1, idempotencyKey: '' }]
	])('rejects %s', async (_name, overrides) => {
		const product = await makeProduct();
		await expect(recordMovement({ productId: product._id, idempotencyKey: nextKey(), ...overrides }))
			.rejects.toMatchObject({ name: 'StockLedgerError' });
		expect(await StockMovement.countDocuments({})).toBe(0);
	});

	it('rejects an invalid product id', async () => {
		await expect(recordMovement({ productId: 'nope', type: 'adjust', delta: 1, idempotencyKey: nextKey() }))
			.rejects.toMatchObject({ name: 'StockLedgerError' });
	});
});

describe('applyMovement', () => {
	it('adds the delta to the cache and records stockAfter; stock may go negative', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const movement = await recordMovement({ productId: product._id, type: 'order', delta: -3, idempotencyKey: nextKey() });

		const result = await applyMovement(movement._id);

		expect(result).toEqual({ applied: true, deferred: false });
		expect(await stockOf(product._id)).toBe(-3);
		const stored = await StockMovement.findById(movement._id).lean();
		expect(stored).toMatchObject({ status: 'applied', stockAfter: -3, delta: -3, attempts: 1 });
		expect(stored.appliedAt).toBeInstanceOf(Date);
	});

	it('applies an already-applied movement as a no-op', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const movement = await adjust(product._id, 4);

		await applyMovement(movement._id);
		const again = await applyMovement(movement._id);

		expect(again).toEqual({ applied: false, deferred: false });
		expect(await stockOf(product._id)).toBe(4);
	});

	it('returns not-applied for a movement id that does not exist', async () => {
		expect(await applyMovement(new mongoose.Types.ObjectId())).toEqual({ applied: false, deferred: false });
	});

	it('counts a movement once when two workers run it at the same time', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const movement = await adjust(product._id, 5);

		const results = await Promise.all([applyMovement(movement._id), applyMovement(movement._id), applyMovement(movement._id)]);

		expect(results.filter((r) => r.applied)).toHaveLength(1);
		expect(await stockOf(product._id)).toBe(5);
		expect((await StockMovement.findById(movement._id)).status).toBe('applied');
	});

	it('applies adjust +10, set_target 3, order -1 of one product in order, even when asked out of order', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const m1 = await adjust(product._id, 10);
		const m2 = await recordMovement({ productId: product._id, type: 'set_target', target: 3, idempotencyKey: nextKey() });
		const m3 = await recordMovement({ productId: product._id, type: 'order', delta: -1, idempotencyKey: nextKey() });

		expect(await applyMovement(m3._id)).toEqual({ applied: false, deferred: true });
		expect(await applyMovement(m2._id)).toEqual({ applied: false, deferred: true });
		expect(await stockOf(product._id)).toBe(0);

		expect((await applyMovement(m1._id)).applied).toBe(true);
		expect((await applyMovement(m2._id)).applied).toBe(true);
		expect((await applyMovement(m3._id)).applied).toBe(true);

		expect(await stockOf(product._id)).toBe(2);
		const setTarget = await StockMovement.findById(m2._id).lean();
		expect(setTarget).toMatchObject({ delta: -7, target: 3, stockAfter: 3 });
		expect((await StockMovement.findById(m3._id).lean()).stockAfter).toBe(2);
	});

	it('does not let one product wait on another product\'s pending movement', async () => {
		const [a, b] = [await makeProduct({ stockQuantity: 0 }), await makeProduct({ stockQuantity: 0 })];
		await adjust(a._id, 1); // older and never applied
		const mb = await adjust(b._id, 2);

		expect((await applyMovement(mb._id)).applied).toBe(true);
		expect(await stockOf(b._id)).toBe(2);
	});

	it('sums 50 concurrent movements across 5 products exactly once each', async () => {
		const products = await Promise.all([1, 2, 3, 4, 5].map((n) => makeProduct({ stockQuantity: n * 100 })));
		const expected = new Map(products.map((p) => [String(p._id), p.stockQuantity]));
		const movements = [];
		for (let i = 0; i < 50; i++) {
			const product = products[i % 5];
			const delta = i % 3 === 0 ? -(i + 1) : i + 1;
			movements.push(await adjust(product._id, delta));
			expected.set(String(product._id), expected.get(String(product._id)) + delta);
		}

		await Promise.all(movements.map((m) => applyUntilDone(m._id)));

		for (const product of products) {
			expect(await stockOf(product._id)).toBe(expected.get(String(product._id)));
		}
		expect(await StockMovement.countDocuments({ status: 'applied' })).toBe(50);
		expect(await StockMovement.countDocuments({ status: 'pending' })).toBe(0);
	});

	it('records the failure, keeps the movement pending and leaves the cache untouched when the apply aborts', async () => {
		const product = await makeProduct({ stockQuantity: 10 });
		const movement = await adjust(product._id, 5);

		// Product write fails after the movement was already flipped inside the transaction.
		const spy = jest.spyOn(Product, 'updateOne').mockRejectedValueOnce(new Error('disk on fire'));
		try {
			await expect(applyMovement(movement._id)).rejects.toThrow('disk on fire');
		} finally {
			spy.mockRestore();
		}

		const stored = await StockMovement.findById(movement._id).lean();
		expect(stored).toMatchObject({ status: 'pending', stockAfter: null, attempts: 1, lastError: 'disk on fire' });
		expect(await stockOf(product._id)).toBe(10);

		// And the retry succeeds.
		expect((await applyMovement(movement._id)).applied).toBe(true);
		expect(await stockOf(product._id)).toBe(15);
	});

	it('logs a critical error once a movement has failed too many times', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const movement = await adjust(product._id, 1);
		await StockMovement.updateOne({ _id: movement._id }, { $set: { attempts: ledger.CRITICAL_AFTER_ATTEMPTS - 1 } });

		const ErrorLogger = require('../../utils/errorLogger');
		const critical = jest.spyOn(ErrorLogger, 'logCritical').mockImplementation(() => {});
		const spy = jest.spyOn(Product, 'updateOne').mockRejectedValueOnce(new Error('still broken'));
		try {
			await expect(applyMovement(movement._id)).rejects.toThrow('still broken');
			expect(critical).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
			critical.mockRestore();
		}
	});

	it('marks a movement applied when its product was deleted, so it cannot block anything', async () => {
		const product = await makeProduct({ stockQuantity: 5 });
		const movement = await adjust(product._id, 1);
		await Product.deleteOne({ _id: product._id });

		const result = await applyMovement(movement._id);

		expect(result.applied).toBe(true);
		expect(await StockMovement.findById(movement._id).lean()).toMatchObject({ status: 'applied', lastError: 'PRODUCT_NOT_FOUND' });
	});
});

describe('reconcile', () => {
	it('lists only the products whose cache differs from the applied movements', async () => {
		const consistent = await makeProduct({ stockQuantity: 0 });
		const tampered = await makeProduct({ stockQuantity: 0 });
		const pendingOnly = await makeProduct({ stockQuantity: 0 });
		for (const p of [consistent, tampered]) {
			await applyMovement((await adjust(p._id, 10))._id);
		}
		await adjust(pendingOnly._id, 4); // pending: counted on neither side
		await Product.updateOne({ _id: tampered._id }, { $set: { stockQuantity: 13 } });
		await adjust(tampered._id, 1);

		const report = await reconcile();

		expect(report).toEqual([{
			productId: String(tampered._id),
			name: tampered.name,
			cached: 13,
			ledgerSum: 10,
			diff: 3,
			pending: 1
		}]);
	});

	it('flags a product with stock but no movements at all', async () => {
		const legacy = await makeProduct({ stockQuantity: 8 });

		expect(await reconcile()).toEqual([expect.objectContaining({ productId: String(legacy._id), cached: 8, ledgerSum: 0, diff: 8 })]);
	});

	it('is read-only: it does not change any cache', async () => {
		const legacy = await makeProduct({ stockQuantity: 8 });

		await reconcile();

		expect(await stockOf(legacy._id)).toBe(8);
		expect(await StockMovement.countDocuments({})).toBe(0);
	});
});

describe('recordAppliedOpening', () => {
	it('records an applied opening once per product', async () => {
		const product = await makeProduct({ stockQuantity: 9 });

		const first = await recordAppliedOpening({ productId: product._id, quantity: 9 });
		const second = await recordAppliedOpening({ productId: product._id, quantity: 9 });

		expect(String(second._id)).toBe(String(first._id));
		expect(await StockMovement.findById(first._id).lean()).toMatchObject({
			type: 'opening', delta: 9, status: 'applied', stockAfter: 9, idempotencyKey: `opening:${product._id}`
		});
		expect(await reconcile()).toEqual([]);
	});
});

describe('enqueueMovements without a configured queue', () => {
	it('resolves and leaves the movement pending', async () => {
		const saved = process.env.REDIS_URL;
		delete process.env.REDIS_URL;
		try {
			const product = await makeProduct();
			const movement = await adjust(product._id, 1);

			await expect(enqueueMovements([movement])).resolves.toBeUndefined();
			expect((await StockMovement.findById(movement._id)).status).toBe('pending');
		} finally {
			if (saved !== undefined) process.env.REDIS_URL = saved;
		}
	});
});
