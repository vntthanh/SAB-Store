const express = require('express');
const request = require('supertest');
const { buildTrustedProxies, DEFAULT_TRUSTED_PROXIES } = require('../../lib/trusted-proxies');
const { requestLogger } = require('../../middleware/logger');
const { createApp } = require('../../server');

function ipApp(trustProxy) {
	const app = express();
	app.set('trust proxy', trustProxy);
	app.use(requestLogger);
	app.get('/api/whoami', (req, res) => res.json({ ip: req.ip }));
	app.get('/api/health', (req, res) => res.json({ ok: true }));
	app.get('/other', (req, res) => res.json({ ip: req.ip }));
	return app;
}

describe('buildTrustedProxies', () => {
	it('defaults to loopback plus the Coolify project range', () => {
		expect(buildTrustedProxies('')).toEqual(['loopback', '10.0.0.0/16']);
		expect(buildTrustedProxies(undefined)).toEqual([...DEFAULT_TRUSTED_PROXIES]);
	});

	it('parses a comma-separated override and drops blanks', () => {
		expect(buildTrustedProxies(' 172.20.0.0/16 , ,loopback')).toEqual(['172.20.0.0/16', 'loopback']);
	});
});

describe('req.ip behind the proxy chain', () => {
	it('is resolved by the app with the shared trust list', () => {
		expect(createApp().get('trust proxy')).toEqual(buildTrustedProxies());
	});

	// supertest connects over loopback, so the peer is 127.0.0.1 / ::1.
	it('trusts X-Forwarded-For from a trusted peer', async () => {
		const res = await request(ipApp(buildTrustedProxies(''))).get('/api/whoami').set('X-Forwarded-For', '1.2.3.4');
		expect(res.body.ip).toBe('1.2.3.4');
	});

	it('ignores X-Forwarded-For from a peer outside the list', async () => {
		const res = await request(ipApp(['10.0.0.0/16'])).get('/api/whoami').set('X-Forwarded-For', '1.2.3.4');
		expect(res.body.ip).not.toBe('1.2.3.4');
		expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
	});
});

describe('requestLogger access line', () => {
	let logSpy;
	beforeEach(() => {
		logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => logSpy.mockRestore());

	// 'finish' can fire just after the client has the response.
	const settle = () => new Promise((resolve) => setImmediate(resolve));

	const accessLines = () => logSpy.mock.calls
		.map(([line]) => { try { return JSON.parse(line); } catch { return null; } })
		.filter((entry) => entry && entry.type === 'access');

	it('records the resolved client ip, status and a query-free path for API requests', async () => {
		await request(ipApp(buildTrustedProxies(''))).get('/api/whoami?token=secret').set('X-Forwarded-For', '1.2.3.4');
		await settle();
		const lines = accessLines();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ ip: '1.2.3.4', method: 'GET', path: '/api/whoami', status: 200 });
		expect(JSON.stringify(lines[0])).not.toContain('secret');
	});

	it('skips health checks and non-API paths', async () => {
		const app = ipApp(buildTrustedProxies(''));
		await request(app).get('/api/health');
		await request(app).get('/other');
		await settle();
		expect(accessLines()).toHaveLength(0);
	});
});
