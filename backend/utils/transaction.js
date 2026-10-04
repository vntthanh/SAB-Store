const mongoose = require('mongoose');

/**
 * Run `fn(session)` in one MongoDB transaction and return its result.
 *
 * Goes through `connection.transaction` rather than a bare
 * `session.withTransaction` because Mongoose also resets the state of documents
 * saved inside the callback when the transaction aborts or is retried; without
 * that, a retried `new Order().save()` would think it was already inserted.
 *
 * The driver re-runs `fn` on a transient error or an unknown commit result, so
 * `fn` must derive everything from the database again on each run and must not
 * call anything external (mail, App Script, queues): those run after this resolves.
 *
 * Any error `fn` throws aborts the transaction and is rethrown unchanged.
 *
 * @template T
 * @param {(session: import('mongoose').ClientSession) => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withTransaction(fn) {
	return mongoose.connection.transaction(fn);
}

module.exports = { withTransaction };
