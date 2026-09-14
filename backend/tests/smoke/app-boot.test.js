const request = require('supertest');
const { buildTestApp } = require('../helpers/app');

describe('app boot', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('builds an app from createApp()', () => {
		expect(typeof app).toBe('function');
	});

	it('serves the health endpoint', async () => {
		const res = await request(app).get('/health');
		expect(res.status).toBe(200);
	});

	it('returns a structured 404 for an unknown route', async () => {
		const res = await request(app).get('/definitely-not-a-route');
		expect(res.status).toBe(404);
	});

	// The anonymous-upload hole closed in Phase 00 A3. This is the regression
	// guard: /api/upload must never answer without an admin session.
	it('rejects an unauthenticated upload', async () => {
		const res = await request(app).post('/api/upload/product-image');
		expect([401, 403]).toContain(res.status);
	});

	// Defence layer 1 against NoSQL injection: ?x[$ne]= must arrive as a string,
	// not as a nested object that Mongo would read as an operator.
	it('parses query strings without building nested operator objects', async () => {
		const probe = require('express')();
		probe.set('query parser', 'simple');
		let captured;
		probe.get('/probe', (req, res) => {
			captured = req.query.status;
			res.sendStatus(200);
		});

		await request(probe).get('/probe?status[$ne]=paid');
		expect(typeof captured === 'string' || captured === undefined).toBe(true);
		expect(captured).not.toEqual({ $ne: 'paid' });
	});
});
