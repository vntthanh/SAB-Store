const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct } = require('../helpers/factories');

// Public /combos/pricing takes an anonymous, user-supplied items array.
// Without bounds an attacker can force a product lookup per item (unbounded
// array) or push quantity toward Infinity/NaN in downstream pricing math.
describe('Combo item bounds — public routes', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('POST /api/combos/pricing rejects an oversized items array (>100)', async () => {
		const items = Array.from({ length: 101 }, () => ({
			productId: '507f1f77bcf86cd799439011',
			quantity: 1
		}));

		const res = await request(app).post('/api/combos/pricing').send({ items });

		expect(res.status).toBe(400);
	});

	it('POST /api/combos/pricing rejects an empty items array', async () => {
		const res = await request(app).post('/api/combos/pricing').send({ items: [] });

		expect(res.status).toBe(400);
	});

	it('POST /api/combos/pricing rejects a non-integer / oversized quantity', async () => {
		const product = await makeProduct();

		const res = await request(app)
			.post('/api/combos/pricing')
			.send({ items: [{ productId: product._id.toString(), quantity: 1e308 }] });

		expect(res.status).toBe(400);
	});

	it('POST /api/combos/pricing rejects a malformed productId', async () => {
		const res = await request(app)
			.post('/api/combos/pricing')
			.send({ items: [{ productId: 'not-an-object-id', quantity: 1 }] });

		expect(res.status).toBe(400);
	});

	it('POST /api/combos/pricing accepts a well-formed items array', async () => {
		const product = await makeProduct();

		const res = await request(app)
			.post('/api/combos/pricing')
			.send({ items: [{ productId: product._id.toString(), quantity: 2 }] });

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
	});

	it('POST /api/combos/pricing rejects a cart over the per-order unit cap, even when split across lines', async () => {
		const product = await makeProduct();
		const other = await makeProduct();

		const res = await request(app)
			.post('/api/combos/pricing')
			.send({
				items: [
					{ productId: product._id.toString(), quantity: 150 },
					{ productId: other._id.toString(), quantity: 51 }
				]
			});

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('CART_TOO_MANY_UNITS');
	});

	it('POST /api/combos/pricing accepts a cart of exactly the unit cap', async () => {
		const product = await makeProduct({ price: 10 });

		const res = await request(app)
			.post('/api/combos/pricing')
			.send({ items: [{ productId: product._id.toString(), quantity: 200 }] });

		expect(res.status).toBe(200);
		expect(res.body.data.totalAmount).toBe(2000);
	});
});
