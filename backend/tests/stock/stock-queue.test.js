/**
 * Queue layer against a real Redis (see helpers/redis.js). Redis is only the
 * dispatcher, so every outcome is asserted on the MongoDB documents.
 */
const Product = require('../../models/Product');
const StockMovement = require('../../models/StockMovement');
const { recordMovement, enqueueMovements } = require('../../services/stock-ledger');
const stockQueue = require('../../queues/stock-queue');
const { makeProduct } = require('../helpers/factories');
const { startRedis, waitFor, START_TIMEOUT_MS } = require('../helpers/redis');

let redis;
let keySeq = 0;
const adjust = (productId, delta, extra = {}) =>
	recordMovement({ productId, type: 'adjust', delta, idempotencyKey: `queue-key-${++keySeq}`, ...extra });
const stockOf = async (id) => (await Product.findById(id)).stockQuantity;
const isApplied = (id) => async () => (await StockMovement.findById(id)).status === 'applied';

beforeAll(async () => {
	await StockMovement.init();
	redis = await startRedis();
	process.env.REDIS_URL = redis.url;
}, START_TIMEOUT_MS);

afterEach(async () => {
	await stockQueue.closeStockQueue();
});

afterAll(async () => {
	delete process.env.REDIS_URL;
	await redis.stop();
});

const startWorker = (options = {}) =>
	stockQueue.startStockWorker({ deferMs: 50, sweepIntervalMs: 100_000, ...options });

describe('stock queue', () => {
	it('applies an enqueued movement', async () => {
		startWorker();
		const product = await makeProduct({ stockQuantity: 0 });
		const movement = await adjust(product._id, -4);

		await enqueueMovements([movement]);

		await waitFor(isApplied(movement._id), { message: 'movement applied' });
		expect(await stockOf(product._id)).toBe(-4);
	});

	it('applies 50 movements for 5 products exactly once each, in order per product', async () => {
		startWorker();
		const products = await Promise.all([1, 2, 3, 4, 5].map(() => makeProduct({ stockQuantity: 0 })));
		const expected = new Map(products.map((p) => [String(p._id), 0]));
		const ids = [];
		for (let i = 0; i < 50; i++) {
			const product = products[i % 5];
			const delta = i + 1;
			ids.push((await adjust(product._id, delta))._id);
			expected.set(String(product._id), expected.get(String(product._id)) + delta);
		}

		await enqueueMovements(ids);
		await waitFor(async () => (await StockMovement.countDocuments({ status: 'pending' })) === 0, { timeoutMs: 30_000, message: 'all applied' });

		for (const product of products) expect(await stockOf(product._id)).toBe(expected.get(String(product._id)));
		expect(await StockMovement.countDocuments({ status: 'applied' })).toBe(50);
	});

	it('defers a younger movement until the older one of the same product is applied', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const older = await adjust(product._id, 10);
		const target = await recordMovement({ productId: product._id, type: 'set_target', target: 3, idempotencyKey: `queue-key-${++keySeq}` });
		const younger = await recordMovement({ productId: product._id, type: 'order', delta: -1, idempotencyKey: `queue-key-${++keySeq}` });

		// Younger ones are queued first and the older one only later, as after a lost job.
		startWorker();
		await enqueueMovements([younger, target]);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await stockOf(product._id)).toBe(0);

		await enqueueMovements([older]);
		await waitFor(isApplied(younger._id), { message: 'younger applied after older' });

		expect(await stockOf(product._id)).toBe(2);
		expect((await StockMovement.findById(target._id)).delta).toBe(-7);
	});

	it('counts a movement once when the same job is enqueued repeatedly', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const movement = await adjust(product._id, 5);

		await enqueueMovements([movement, movement]);
		await enqueueMovements([movement]);
		startWorker();
		await waitFor(isApplied(movement._id), { message: 'applied' });
		await enqueueMovements([movement]);
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(await stockOf(product._id)).toBe(5);
	});

	it('the sweeper re-enqueues a stranded movement (worker died after claiming it) and it applies once', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		const movement = await adjust(product._id, 6);
		// What a crashed worker leaves behind: claimed, attempted, still pending, no job in Redis.
		// Native driver: mongoose treats createdAt as immutable and would drop the backdating.
		await StockMovement.collection.updateOne(
			{ _id: movement._id },
			{ $set: { claimedAt: new Date(Date.now() - 120_000), attempts: 1, createdAt: new Date(Date.now() - 120_000) } }
		);

		startWorker({ sweepIntervalMs: 100, sweepMinAgeMs: 60_000 });

		await waitFor(isApplied(movement._id), { message: 'swept and applied' });
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(await stockOf(product._id)).toBe(6);
		expect(await StockMovement.countDocuments({ status: 'applied' })).toBe(1);
	});

	it('does not sweep a movement younger than the minimum age', async () => {
		const product = await makeProduct({ stockQuantity: 0 });
		await adjust(product._id, 1);

		expect(await stockQueue.sweepOnce({ olderThanMs: 60_000 })).toBe(0);
	});

	it('keeps recording movements while Redis is down, and applies them once it is back', async () => {
		if (redis.external) return; // an external Redis cannot be stopped from here
		startWorker();
		const product = await makeProduct({ stockQuantity: 0 });
		const warm = await adjust(product._id, 1);
		await enqueueMovements([warm]);
		await waitFor(isApplied(warm._id), { message: 'warm-up applied' });

		await redis.stop();
		const during = await adjust(product._id, 2);
		await expect(enqueueMovements([during])).resolves.toBeUndefined();
		expect((await StockMovement.findById(during._id)).status).toBe('pending');

		await redis.restart();
		await waitFor(async () => {
			await stockQueue.sweepOnce({ olderThanMs: 0 }).catch(() => 0);
			return (await StockMovement.findById(during._id)).status === 'applied';
		}, { timeoutMs: 30_000, intervalMs: 500, message: 'applied after Redis returned' });

		expect(await stockOf(product._id)).toBe(3);
	}, 60_000);
});
