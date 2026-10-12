const { prisma } = require('../../lib/prisma');
const { logEvent } = require('../../utils/log-event');

// Postgres aborts one side of a deadlock (40P01) or serialization failure
// (40001). Prisma reports them as P2034 from its own operations, but from a
// `$queryRaw`/`$executeRaw` (the FOR UPDATE reads) it reports a generic P2010
// carrying the SQLSTATE, so both spellings count. Anything else is the caller's
// error and is not retried.
const RETRYABLE_CODE = 'P2034';
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);
const MAX_ATTEMPTS = 3;

function isRetryable(err) {
	if (!err) return false;
	if (err.code === RETRYABLE_CODE) return true;
	const cause = err.meta && err.meta.driverAdapterError && err.meta.driverAdapterError.cause;
	return Boolean(cause) && RETRYABLE_SQLSTATES.has(cause.originalCode);
}

/**
 * Run `fn(tx)` in one database transaction and return its result. `tx` is opaque:
 * hand it to repository functions and to nothing else.
 *
 * Read Committed on purpose: correctness comes from the explicit row locks and
 * the gated updates in the repositories, not from snapshot isolation.
 *
 * Retry contract: on a deadlock or serialization failure `fn` is re-run
 * from the top, up to three attempts in all. So `fn` must derive everything from
 * the database again on each run, keep no state across runs, and must NOT call
 * anything external (mail, App Script, queues, QR): an external effect cannot be
 * rolled back, and a re-run would repeat it. Do those after this resolves.
 *
 * Any other error `fn` throws aborts the transaction and is rethrown unchanged.
 * Wait and timeout limits are the client's `transactionOptions` (lib/prisma.js)
 * unless `options` (`{ maxWait, timeout }` in ms) overrides them, for the rare
 * transaction that legitimately runs long.
 *
 * @template T
 * @param {(tx: object) => Promise<T>} fn
 * @param {{maxWait?: number, timeout?: number}} [options]
 * @returns {Promise<T>}
 */
async function runTransaction(fn, isolationLevel, options) {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await prisma.$transaction(fn, { ...options, isolationLevel });
		} catch (err) {
			if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) throw err;
			logEvent('db.tx.retry', { attempt });
		}
	}
}

const withTransaction = (fn, options) => runTransaction(fn, 'ReadCommitted', options);

/**
 * Like `withTransaction`, but every statement sees one point in time (Repeatable
 * Read), for reads that must agree with each other, such as a whole-store export.
 * Meant for read-only work: a write conflict here is a serialization failure and
 * is retried like a deadlock, so `fn` must obey the same re-run contract.
 */
const withSnapshotTransaction = (fn, options) => runTransaction(fn, 'RepeatableRead', options);

module.exports = { withTransaction, withSnapshotTransaction };
