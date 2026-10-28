const { clearAppModules } = require('../helpers/require-cache');

/**
 * lib/auth.js validates JWT_SECRET at require time (module top level), so each
 * case here mutates process.env then forces a fresh module evaluation with
 * clearAppModules(). The store settings are left untouched — the Prisma pool
 * does not connect eagerly, and the secret is checked before it is created, so
 * these cases fail (or don't) purely on the JWT_SECRET check, before any
 * network I/O.
 */
describe('JWT_SECRET fail-fast', () => {
	const originalSecret = process.env.JWT_SECRET;

	afterEach(async () => {
		process.env.JWT_SECRET = originalSecret;
		await clearAppModules();
	});

	it('throws when JWT_SECRET is missing', async () => {
		delete process.env.JWT_SECRET;
		await clearAppModules();
		expect(() => require('../../lib/auth')).toThrow(/JWT_SECRET/);
	});

	it('throws when JWT_SECRET is shorter than 32 characters', async () => {
		process.env.JWT_SECRET = 'too-short';
		await clearAppModules();
		expect(() => require('../../lib/auth')).toThrow(/at least 32 characters/);
	});

	it('throws when JWT_SECRET is a known placeholder value', async () => {
		// 32+ chars so it passes the length check and exercises the placeholder check.
		process.env.JWT_SECRET = 'change-this-in-production-please';
		await clearAppModules();
		expect(() => require('../../lib/auth')).toThrow(/placeholder/);
	});

	it('boots with a real secret', async () => {
		process.env.JWT_SECRET = 'a-real-secret-value-that-is-at-least-32-chars';
		await clearAppModules();
		expect(() => require('../../lib/auth')).not.toThrow();
	});
});
