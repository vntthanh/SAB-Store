/**
 * BullMQ transport for stock movements.
 *
 * Redis here is a dispatcher, never the source of truth: the pending movement in
 * MongoDB is. A job lost with Redis' data, or never enqueued because Redis was
 * down, only delays the cache; the sweeper below re-enqueues anything still
 * pending after a minute, using the same job id so it cannot be queued twice.
 */
const { Queue, Worker, DelayedError } = require('bullmq');
const IORedis = require('ioredis');
const StockMovement = require('../models/StockMovement');
const { applyMovement } = require('../services/stock-ledger');
const ErrorLogger = require('../utils/errorLogger');

const QUEUE_NAME = 'stock-movements';
const WORKER_CONCURRENCY = 5;
const SWEEP_INTERVAL_MS = 30_000;
const SWEEP_MIN_AGE_MS = 60_000;
const SWEEP_BATCH = 500;
// How long a movement waits when an older one of the same product is pending.
const DEFER_MS = 2_000;
const LOG_THROTTLE_MS = 30_000;

let queue = null;
let queueConnection = null;
let runtime = null;

// Not an integer-looking id: BullMQ rejects custom job ids that are integers,
// and a 24-character hex ObjectId made only of digits would be one.
const jobIdFor = (movementId) => `movement-${movementId}`;

function redisUrl() {
	return process.env.REDIS_URL || null;
}

function isConfigured() {
	return redisUrl() !== null;
}

/** ioredis re-emits every reconnect failure as 'error'; log it, but not once per attempt. */
function throttledErrorLogger(source) {
	let lastLoggedAt = 0;
	return (err) => {
		const now = Date.now();
		if (now - lastLoggedAt < LOG_THROTTLE_MS) return;
		lastLoggedAt = now;
		ErrorLogger.logWarning(`Redis error (${source})`, { error: err && err.message });
	};
}

/**
 * The producer queue, or null when REDIS_URL is not set.
 *
 * `enableOfflineQueue: false` makes `add` fail at once while Redis is down
 * instead of buffering commands in memory and holding the caller's request open.
 */
function getQueue() {
	if (queue) return queue;
	const url = redisUrl();
	if (!url) return null;

	queueConnection = new IORedis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
	queueConnection.on('error', throttledErrorLogger('producer connection'));
	queue = new Queue(QUEUE_NAME, {
		connection: queueConnection,
		defaultJobOptions: {
			attempts: 5,
			backoff: { type: 'exponential', delay: 1_000 },
			// MongoDB keeps the history. A job left behind (completed or failed) would
			// also make a later add with the same id a no-op, so the sweeper could
			// never retry that movement.
			removeOnComplete: true,
			removeOnFail: true
		}
	});
	queue.on('error', throttledErrorLogger('queue'));
	return queue;
}

/**
 * Add one apply job per movement id. Adding an id that already has a job is a no-op.
 * Throws when Redis is unreachable; does nothing when REDIS_URL is not set.
 *
 * @param {string[]} movementIds
 */
async function enqueueMovementJobs(movementIds) {
	const producer = getQueue();
	if (!producer || movementIds.length === 0) return;
	await producer.addBulk(movementIds.map((id) => ({
		name: 'apply',
		data: { movementId: id },
		opts: { jobId: jobIdFor(id) }
	})));
}

/**
 * Re-enqueue movements that are still pending after `olderThanMs`. Covers a job
 * lost with Redis, an enqueue that failed, and a worker that died mid-apply.
 *
 * @returns {Promise<number>} how many movements were offered to the queue
 */
async function sweepOnce({ olderThanMs = SWEEP_MIN_AGE_MS, limit = SWEEP_BATCH } = {}) {
	const cutoff = new Date(Date.now() - olderThanMs);
	const stale = await StockMovement.find({ status: 'pending', createdAt: { $lt: cutoff } })
		.sort({ createdAt: 1, _id: 1 })
		.limit(limit)
		.select('_id')
		.lean();
	if (stale.length === 0) return 0;
	await enqueueMovementJobs(stale.map((m) => String(m._id)));
	return stale.length;
}

function makeProcessor(deferMs) {
	return async (job, token) => {
		const result = await applyMovement(job.data.movementId);
		if (result.deferred) {
			// An older movement of this product is still pending. Park this job rather
			// than fail it, so waiting does not burn its retry attempts.
			await job.moveToDelayed(Date.now() + deferMs, token);
			throw new DelayedError();
		}
		return result;
	};
}

/**
 * Start the worker and the sweeper in this process. Needs REDIS_URL.
 * Call once, from the server start path.
 *
 * @returns {{close: () => Promise<void>}}
 */
function startStockWorker({
	concurrency = WORKER_CONCURRENCY,
	sweepIntervalMs = SWEEP_INTERVAL_MS,
	sweepMinAgeMs = SWEEP_MIN_AGE_MS,
	deferMs = DEFER_MS
} = {}) {
	if (runtime) return runtime;
	const url = redisUrl();
	if (!url) throw new Error('REDIS_URL is not set; the stock worker cannot start');

	// A worker must retry forever across a Redis outage instead of rejecting commands.
	const workerConnection = new IORedis(url, { maxRetriesPerRequest: null });
	workerConnection.on('error', throttledErrorLogger('worker connection'));

	const worker = new Worker(QUEUE_NAME, makeProcessor(deferMs), {
		connection: workerConnection,
		concurrency,
		// A stalled job is retried at most once. Applying twice is harmless anyway
		// (the apply is gated on the movement still being pending); this just
		// stops a job that keeps killing its worker from cycling forever.
		maxStalledCount: 1
	});
	worker.on('error', throttledErrorLogger('worker'));
	worker.on('failed', (job, err) => {
		ErrorLogger.logWarning('Stock movement job failed', {
			movementId: job && job.data && job.data.movementId,
			attemptsMade: job && job.attemptsMade,
			error: err && err.message
		});
	});

	let sweeping = false;
	const sweep = async () => {
		if (sweeping) return;
		sweeping = true;
		try {
			const count = await sweepOnce({ olderThanMs: sweepMinAgeMs });
			if (count > 0) ErrorLogger.logInfo('Stock sweeper re-enqueued pending movements', { count });
		} catch (err) {
			ErrorLogger.logWarning('Stock sweeper run failed', { error: err.message });
		} finally {
			sweeping = false;
		}
	};
	const timer = setInterval(sweep, sweepIntervalMs);
	timer.unref();
	// A restart is the most likely moment for movements to be stranded.
	sweep();

	runtime = {
		async close() {
			clearInterval(timer);
			runtime = null;
			await worker.close();
			workerConnection.disconnect();
		}
	};
	return runtime;
}

/** Stop the worker and sweeper (if running) and close the producer connection. */
async function closeStockQueue() {
	if (runtime) await runtime.close();
	if (queue) {
		const closing = queue;
		queue = null;
		await closing.close();
	}
	if (queueConnection) {
		queueConnection.disconnect();
		queueConnection = null;
	}
}

module.exports = {
	QUEUE_NAME,
	isConfigured,
	getQueue,
	enqueueMovementJobs,
	sweepOnce,
	startStockWorker,
	closeStockQueue
};
