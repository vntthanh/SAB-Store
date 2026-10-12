/**
 * Stand-in for a repository the postgres backend does not have yet. Any use
 * fails with a message naming the call: falling back to the mongo repository
 * would silently split one workload across two stores.
 *
 * @param {string} repository name as exported by data/index.js
 * @returns {object}
 */
function notImplemented(repository) {
	return new Proxy({}, {
		get(_target, property) {
			// Symbols are probed by inspectors and the runtime, not by callers.
			if (typeof property === 'symbol') return undefined;
			throw new Error(`${repository}.${property} is not implemented in postgres yet`);
		}
	});
}

module.exports = { notImplemented };
