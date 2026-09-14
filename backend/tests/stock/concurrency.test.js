/**
 * 20 parallel purchases of the last unit — the concurrency invariant this
 * whole phase exists to guarantee: no overselling, stock never negative.
 *
 * Covers both levels: the primitive directly (services/stock.js) and the
 * full HTTP path a seller actually hits (POST /api/seller/orders/direct),
 * which is where the old `product.stockQuantity -= qty; await product.save()`
 * read-modify-write race actually lived.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession } = require('../helpers/factories');
const { deductStock } = require('../../services/stock');
const Product = require('../../models/Product');

describe('concurrency: last unit, 20 parallel buyers', () => {
	it('deductStock: exactly one of 20 concurrent deductions of the last unit succeeds', async () => {
		const product = await makeProduct({ stockQuantity: 1 });

		const results = await Promise.allSettled(
			Array.from({ length: 20 }, () => deductStock(product._id, 1))
		);

		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected');

		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(19);
		expect(rejected.every((r) => r.reason.code === 'INSUFFICIENT_STOCK')).toBe(true);

		const final = await Product.findById(product._id);
		expect(final.stockQuantity).toBe(0);
		expect(final.stockQuantity).toBeGreaterThanOrEqual(0);
	});

	it('deductStock: same invariant with a starting stock of 5 and 20 buyers of 1 each — exactly 5 succeed', async () => {
		const product = await makeProduct({ stockQuantity: 5 });

		const results = await Promise.allSettled(
			Array.from({ length: 20 }, () => deductStock(product._id, 1))
		);

		expect(results.filter((r) => r.status === 'fulfilled').length).toBe(5);
		expect(results.filter((r) => r.status === 'rejected').length).toBe(15);

		const final = await Product.findById(product._id);
		expect(final.stockQuantity).toBe(0);
	});

	it('POST /api/seller/orders/direct: exactly one of 20 concurrent direct sales of the last unit succeeds, stock never goes negative', async () => {
		const app = buildTestApp();
		const { cookies } = await makeAdminSession(app); // admin role also passes authenticateSeller
		const product = await makeProduct({ stockQuantity: 1, price: 50000, category: 'concurrency-test' });

		const responses = await Promise.all(
			Array.from({ length: 20 }, () =>
				request(app)
					.post('/api/seller/orders/direct')
					.set('Cookie', cookies)
					.send({ items: [{ productId: String(product._id), quantity: 1 }] })
			)
		);

		const succeeded = responses.filter((r) => r.status === 201);
		const failed = responses.filter((r) => r.status !== 201);

		expect(succeeded.length).toBe(1);
		expect(failed.length).toBe(19);
		expect(failed.every((r) => r.status === 400)).toBe(true);

		const final = await Product.findById(product._id);
		expect(final.stockQuantity).toBe(0);
	}, 30000);
});
