/**
 * lib/auth.js validates JWT_SECRET at require time (module top level), so each
 * case here mutates process.env then forces a fresh module evaluation with
 * jest.resetModules(). MONGODB_URI is left untouched — the constructor for
 * MongoClient does not connect eagerly, so these cases fail (or don't) purely
 * on the JWT_SECRET check, before any network I/O.
 */
describe('JWT_SECRET fail-fast', () => {
	const originalSecret = process.env.JWT_SECRET;

	afterEach(() => {
		process.env.JWT_SECRET = originalSecret;
		jest.resetModules();
	});

	it('throws when JWT_SECRET is missing', () => {
		delete process.env.JWT_SECRET;
		jest.resetModules();
		expect(() => require('../../lib/auth')).toThrow(/JWT_SECRET/);
	});

	it('throws when JWT_SECRET is shorter than 32 characters', () => {
		process.env.JWT_SECRET = 'too-short';
		jest.resetModules();
		expect(() => require('../../lib/auth')).toThrow(/at least 32 characters/);
	});

	it('throws when JWT_SECRET is a known placeholder value', () => {
		// 32+ chars so it passes the length check and exercises the placeholder check.
		process.env.JWT_SECRET = 'change-this-in-production-please';
		jest.resetModules();
		expect(() => require('../../lib/auth')).toThrow(/placeholder/);
	});

	it('boots with a real secret', () => {
		process.env.JWT_SECRET = 'a-real-secret-value-that-is-at-least-32-chars';
		jest.resetModules();
		expect(() => require('../../lib/auth')).not.toThrow();
	});
});
