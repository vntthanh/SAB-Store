import { defineConfig } from 'vitest/config';
import base from './vitest.config.mjs';

// The whole backend suite with the data layer on Mongo, the rollback store. Written with a
// spread rather than mergeConfig, which would concatenate arrays such as `include`.
export default defineConfig({
	...base,
	test: {
		...base.test,
		env: { DATA_BACKEND: 'mongo' },
	},
});
