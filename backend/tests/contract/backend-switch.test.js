/**
 * DATA_BACKEND picks the repositories; a repository the chosen backend lacks
 * must fail loudly, never answer from the other store.
 */
const data = require('../../data');

const POSTGRES = process.env.DATA_BACKEND === 'postgres';

describe('data backend switch', () => {
	it('exposes the repositories of the selected backend', () => {
		const expected = POSTGRES ? '../../data/postgres/stock-ledger' : '../../data/mongo/stock-ledger';

		expect(data.stockLedger).toBe(require(expected));
		expect(typeof data.withTransaction).toBe('function');
		expect(typeof data.translateWriteError).toBe('function');
	});

	it.skipIf(!POSTGRES)('throws a clear error when a postgres repository that is not written yet is used', () => {
		for (const repository of ['orders', 'products', 'combos', 'settings', 'dataSnapshot', 'dashboard', 'bootstrap']) {
			expect(() => data[repository].anything, repository).toThrow(`${repository}.anything is not implemented in postgres yet`);
		}
	});

	it.skipIf(!POSTGRES)('rejects an unknown backend name at load time', () => {
		// Plain CommonJS: vitest's module reset does not reach the require cache.
		const modules = [require.resolve('../../data'), require.resolve('../../data/backend-name')];
		const cached = modules.map((file) => require.cache[file]);
		modules.forEach((file) => delete require.cache[file]);
		process.env.DATA_BACKEND = 'sqlite';
		try {
			expect(() => require('../../data')).toThrow('Unknown DATA_BACKEND "sqlite"');
		} finally {
			process.env.DATA_BACKEND = 'postgres';
			modules.forEach((file, i) => { require.cache[file] = cached[i]; });
		}
	});
});
