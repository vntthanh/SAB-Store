/**
 * The access line is what the log pipeline groups and counts by, and it leaves
 * the database's access controls: it must carry the endpoint template, never the
 * credential in the URL.
 */
const express = require('express');
const request = require('supertest');
const { requestLogger } = require('../../middleware/logger');

function loggedApp() {
	const app = express();
	app.use(requestLogger);
	const orders = express.Router();
	orders.post('/', (req, res) => res.status(201).json({}));
	orders.get('/:orderCode', (req, res) => res.json({}));
	orders.put('/:orderCode', (req, res) => res.status(404).json({}));
	app.use('/api/orders', orders);
	const products = express.Router();
	products.get('/:id/stock', (req, res) => res.json({}));
	app.use('/api/products', products);
	app.get('/api/health', (req, res) => res.json({}));
	return app;
}

describe('access log line', () => {
	let logSpy;
	beforeEach(() => {
		logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => logSpy.mockRestore());

	const settle = () => new Promise((resolve) => setImmediate(resolve));
	const accessLines = () => logSpy.mock.calls
		.map(([line]) => { try { return JSON.parse(line); } catch { return null; } })
		.filter((entry) => entry && entry.type === 'access');

	it('adds the route template for a matched route', async () => {
		await request(loggedApp()).get('/api/products/64b000000000000000000000/stock');
		await settle();
		expect(accessLines()[0]).toMatchObject({
			path: '/api/products/64b000000000000000000000/stock',
			route: '/api/products/:id/stock',
			status: 200
		});
	});

	it('masks the order code of the public lookup in the path and keeps no query', async () => {
		await request(loggedApp()).get('/api/orders/ABCDE12345?token=secret');
		await settle();
		const [line] = accessLines();
		expect(line).toMatchObject({ method: 'GET', path: '/api/orders/:code', route: '/api/orders/:orderCode' });
		expect(JSON.stringify(line)).not.toMatch(/ABCDE12345|secret/);
	});

	it('masks the order code for HEAD too', async () => {
		await request(loggedApp()).head('/api/orders/ABCDE12345');
		await settle();
		const [line] = accessLines();
		expect(line).toMatchObject({ method: 'HEAD', path: '/api/orders/:code' });
		expect(JSON.stringify(line)).not.toContain('ABCDE12345');
	});

	it('keeps the order code and the query out of the client-error warning', async () => {
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
		await request(loggedApp()).put('/api/orders/ABCDE12345?token=secret');
		await settle();
		expect(warnSpy).toHaveBeenCalled();
		expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(/ABCDE12345|secret/);
		expect(JSON.stringify(warnSpy.mock.calls)).toContain('/api/orders/:code');
		warnSpy.mockRestore();
	});

	it('leaves the order collection path alone', async () => {
		await request(loggedApp()).post('/api/orders').send({ studentId: '24120001' });
		await settle();
		const [line] = accessLines();
		expect(line).toMatchObject({ method: 'POST', path: '/api/orders', route: '/api/orders/', status: 201 });
		expect(JSON.stringify(line)).not.toContain('24120001');
	});

	it('omits route when nothing matched', async () => {
		await request(loggedApp()).get('/api/nope');
		await settle();
		const [line] = accessLines();
		expect(line).toMatchObject({ path: '/api/nope', status: 404 });
		expect(line).not.toHaveProperty('route');
	});

	it('does not log health checks', async () => {
		await request(loggedApp()).get('/api/health');
		await settle();
		expect(accessLines()).toHaveLength(0);
	});
});
