const request = require('supertest');
const { buildTestApp } = require('../helpers/app');

// tests/env.js sets CORS_ORIGIN=http://localhost:3000. server.js and
// lib/auth.js must read allowed origins from that single env-driven source —
// no domain (sab.edu.vn or otherwise) may be hardcoded in either file.
describe('CORS allowlist', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('reflects an allowed origin and varies on Origin', async () => {
		const res = await request(app)
			.get('/health')
			.set('Origin', 'http://localhost:3000');

		expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
		expect(res.headers['access-control-allow-credentials']).toBe('true');
		expect(res.headers['vary']).toContain('Origin');
	});

	it('does not reflect a disallowed origin', async () => {
		const res = await request(app)
			.get('/health')
			.set('Origin', 'https://not-allowed.example.com');

		expect(res.headers['access-control-allow-origin']).toBeUndefined();
	});

	it('does not carry a stale sab.edu.vn or sabies.vn hardcode', () => {
		const { getAllowedOrigins } = require('../../lib/auth');
		const origins = getAllowedOrigins();
		expect(origins.some((o) => /sab\.edu\.vn|sabies\.vn/.test(o))).toBe(false);
	});
});
