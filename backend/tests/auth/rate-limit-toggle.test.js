const request = require('supertest');
const { buildTestApp } = require('../helpers/app');

/**
 * Rate limiting must stay OFF until `req.ip` has been verified against real
 * production traffic (two different source IPs must produce two different
 * req.ip values through the actual NPM -> nginx -> backend hop chain). See
 * the phase report. This suite only proves the switch works in both
 * directions; it does not assert anything about production's current state.
 */
describe('rate limiting toggle', () => {
	const originalFlag = process.env.RATE_LIMIT_ENABLED;

	afterEach(() => {
		if (originalFlag === undefined) {
			delete process.env.RATE_LIMIT_ENABLED;
		} else {
			process.env.RATE_LIMIT_ENABLED = originalFlag;
		}
	});

	it('is off by default: a burst of requests to /api/auth is never limited', async () => {
		delete process.env.RATE_LIMIT_ENABLED;
		const app = buildTestApp();

		for (let i = 0; i < 25; i += 1) {
			// eslint-disable-next-line no-await-in-loop
			const res = await request(app).get('/api/auth/get-session');
			expect(res.status).not.toBe(429);
		}
	});

	it('limits the 21st request to /api/auth within the window once enabled', async () => {
		process.env.RATE_LIMIT_ENABLED = 'true';
		const app = buildTestApp();

		let lastStatus;
		for (let i = 0; i < 21; i += 1) {
			// eslint-disable-next-line no-await-in-loop
			const res = await request(app).get('/api/auth/get-session');
			lastStatus = res.status;
		}

		expect(lastStatus).toBe(429);
	});
});
