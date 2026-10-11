import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		// Forks, not threads: mongodb, sharp and ioredis are native/handle-heavy and
		// each worker needs its own process.env (per-worker database name).
		pool: 'forks',
		// One in-memory replica set and one embedded PostgreSQL for the whole run, started
		// in the main process. Their teardown is the function global-setup.js returns.
		globalSetup: ['./tests/global-setup.js'],
		// env.js must run before modules load: lib/auth.js validates secrets at require time.
		// Vitest runs setupFiles in order, before each test file.
		setupFiles: ['./tests/env.js', './tests/setup.js'],
		include: ['tests/**/*.test.js'],
		testTimeout: 30000,
		hookTimeout: 30000,
		coverage: {
			include: ['services/**/*.js', 'utils/**/*.js', 'routes/**/*.js', 'middleware/**/*.js'],
		},
	},
});
