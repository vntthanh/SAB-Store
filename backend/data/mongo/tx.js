const mongoose = require('mongoose');

/**
 * Run `fn(tx)` in one database transaction and return its result. `tx` is opaque:
 * hand it to repository functions and to nothing else.
 *
 * Retry contract: the store re-runs `fn` from the top on a transient error or an
 * unknown commit result. So `fn` must derive everything from the database again
 * on each run, keep no state across runs, and must NOT call anything external
 * (mail, App Script, queues, QR): an external effect cannot be rolled back, and a
 * re-run would repeat it. Do those after this resolves.
 *
 * Any error `fn` throws aborts the transaction and is rethrown unchanged.
 *
 * Goes through `connection.transaction` rather than a bare
 * `session.withTransaction` because Mongoose also resets the state of documents
 * saved inside the callback when the transaction aborts or is retried; without
 * that, a retried `new Order().save()` would think it was already inserted.
 *
 * @template T
 * @param {(tx: object) => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withTransaction(fn) {
	return mongoose.connection.transaction(fn);
}

module.exports = { withTransaction };
