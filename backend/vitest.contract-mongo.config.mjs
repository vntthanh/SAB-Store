import { defineConfig } from 'vitest/config';
import base from './vitest.config.mjs';

// Only the repository contract suite, on Mongo. The same files run on Postgres in the default
// suite, so the rollback store keeps honouring the contracts. Spread rather than mergeConfig,
// which would concatenate `include` and run the whole suite.
export default defineConfig({
	...base,
	test: {
		...base.test,
		env: { DATA_BACKEND: 'mongo' },
		include: ['tests/contract/**/*.test.js'],
	},
});
