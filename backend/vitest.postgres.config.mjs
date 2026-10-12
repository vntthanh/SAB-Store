import { defineConfig } from 'vitest/config';
import base from './vitest.config.mjs';

// The whole backend suite with the data layer on Postgres. See
// vitest.contract-postgres.config.mjs for why `test.env` and a spread.
export default defineConfig({
	...base,
	test: {
		...base.test,
		env: { DATA_BACKEND: 'postgres' },
	},
});
