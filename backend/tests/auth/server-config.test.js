const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { clearAppModules } = require('../helpers/require-cache');

describe('server hardening config', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('does not allow unsafe-inline or unsafe-eval in the script-src CSP directive', async () => {
		const res = await request(app).get('/health');
		const csp = res.headers['content-security-policy'];
		expect(csp).toBeDefined();

		const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
		expect(scriptSrc).toBeDefined();
		expect(scriptSrc).not.toContain("'unsafe-inline'");
		expect(scriptSrc).not.toContain("'unsafe-eval'");
	});

	it('rejects a JSON body larger than 1mb', async () => {
		const res = await request(app)
			.post('/api/orders')
			.set('Content-Type', 'application/json')
			.send({ padding: 'x'.repeat(2 * 1024 * 1024) });

		// express.json() rejects the body before any route handler runs; the
		// exact status is Phase 07's error-mapping concern, but it must not be
		// silently accepted as 2xx.
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	it('disables the better-auth OpenAPI reference outside development', async () => {
		const originalEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production';
		try {
			await clearAppModules();
			// eslint-disable-next-line global-require
			const { createApp } = require('../../server');
			const prodApp = createApp();

			const res = await request(prodApp).get('/api/auth/reference');
			expect(res.status).toBe(404);
		} finally {
			process.env.NODE_ENV = originalEnv;
			await clearAppModules();
		}
	});
});
