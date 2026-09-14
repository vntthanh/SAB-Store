module.exports = {
	testEnvironment: 'node',
	// One in-memory replica set for the whole run, started outside the test
	// sandbox. See tests/global-setup.js for why it cannot live in a hook.
	globalSetup: '<rootDir>/tests/global-setup.js',
	globalTeardown: '<rootDir>/tests/global-teardown.js',
	// env.js must run before modules load: lib/auth.js validates secrets at require time.
	setupFiles: ['<rootDir>/tests/env.js'],
	setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
	testMatch: ['<rootDir>/tests/**/*.test.js'],
	testTimeout: 30000,
	// better-auth opens its own MongoClient at require time and never exposes it
	// for closing, so the process keeps a live handle after the last test and the
	// run hangs instead of exiting. Drop this once lib/auth.js exports the client
	// and tests/setup.js can close it in afterAll.
	forceExit: true,
	collectCoverageFrom: [
		'services/**/*.js',
		'utils/**/*.js',
		'routes/**/*.js',
		'middleware/**/*.js',
	],
};
