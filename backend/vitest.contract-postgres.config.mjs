import { defineConfig } from 'vitest/config';
import base from './vitest.config.mjs';

// The contract suite again, with the data layer on Postgres. `test.env` is set in
// every worker before the setup files, so data/index.js and tests/helpers/db.js
// pick the backend the same way a deployment would. Written with a spread rather
// than mergeConfig, which would concatenate `include` and run the whole suite.
export default defineConfig({
	...base,
	test: {
		...base.test,
		env: { DATA_BACKEND: 'postgres' },
		include: ['tests/contract/**/*.test.js'],
	},
});
