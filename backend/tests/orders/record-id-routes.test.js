/**
 * Routes that take a record id in the path accept the store's own id form, and on
 * Postgres also a legacy 24-hex id (old links, carts and backups still carry it).
 * The path check must therefore be the backend-aware one, not a hex-only pattern.
 */
const request = require('supertest');
const { v7: uuidv7 } = require('uuid');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeAdminSession, makeSellerSession } =require('../helpers/factories');
const { objectIdToUuidV7 } = require('@sab/shared');
const data = require('../../data');
const { POSTGRES } = require('../helpers/backend');

const HEX = '507f1f77bcf86cd799439011';

describe('record ids in route paths', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	it('answers 404 for a well-formed id nothing has, on the public product route', async () => {
		const unknown = POSTGRES ? uuidv7() : HEX;

		const res = await request(app).get(`/api/products/${unknown}`);

		expect(res.status).toBe(404);
	});

	it('answers 404 for a well-formed id nothing has, on the admin order route', async () => {
		const unknown = POSTGRES ? uuidv7() : HEX;

		const res = await request(app).get(`/api/admin/orders/${unknown}`).set('Cookie', cookies);

		expect(res.status).toBe(404);
	});

	it('reads a stored product through the stock routes by its own id', async () => {
		const product = await makeProduct({ stockQuantity: 5 });

		const movements = await request(app).get(`/api/admin/products/${product._id}/stock-movements`).set('Cookie', cookies);
		const adjust = await request(app).post(`/api/admin/products/${product._id}/stock-adjustments`).set('Cookie', cookies)
			.send({ mode: 'delta', value: 1, reason: 'count' });

		expect(movements.status).toBe(200);
		expect(adjust.status).toBe(202);
		expect(String(adjust.body.data.productId)).toBe(String(product._id));
	});

	it('refuses a malformed id before any lookup', async () => {
		for (const bad of ['not-an-id', `${HEX}0`, '12345']) {
			const adjust = await request(app).post(`/api/admin/products/${bad}/stock-adjustments`).set('Cookie', cookies)
				.send({ mode: 'delta', value: 1, reason: 'count' });
			const movements = await request(app).get(`/api/admin/products/${bad}/stock-movements`).set('Cookie', cookies);
			const publicProduct = await request(app).get(`/api/products/${bad}`);

			expect([adjust.status, movements.status, publicProduct.status], bad).toEqual([400, 400, 404]);
		}
	});

	// Mongo only: a uuid is not an id there and is refused as malformed.
	it.skipIf(POSTGRES)('refuses a uuid as a malformed id', async () => {
		const res = await request(app).get(`/api/admin/products/${uuidv7()}/stock-movements`).set('Cookie', cookies);

		expect(res.status).toBe(400);
	});

	// The request schema accepts a uuid on every backend. On Mongo the repository refuses
	// it as a malformed id (400, never a 500); on Postgres it is a well-formed id nothing has (404).
	describe('a uuid order id on a write route', () => {
		const expected = POSTGRES ? 404 : 400;
		const productId = POSTGRES ? uuidv7() : HEX;

		it(`answers ${expected} on the admin status update`, async () => {
			const res = await request(app).put(`/api/admin/orders/${uuidv7()}`).set('Cookie', cookies).send({ status: 'paid' });

			expect(res.status).toBe(expected);
		});

		it(`answers ${expected} on the admin item edit`, async () => {
			const res = await request(app).put(`/api/admin/orders/${uuidv7()}/items`).set('Cookie', cookies)
				.send({ items: [{ productId, quantity: 1 }], expectedRevision: 0, reason: 'Khách đổi màu' });

			expect(res.status).toBe(expected);
		});

		it(`answers ${expected} on the admin note update`, async () => {
			const res = await request(app).patch(`/api/admin/orders/${uuidv7()}/notes`).set('Cookie', cookies).send({ additionalNote: 'ghi chú' });

			expect(res.status).toBe(expected);
		});

		it(`answers ${expected} on the seller status update`, async () => {
			const seller = await makeSellerSession(app);

			const res = await request(app).put(`/api/seller/orders/${uuidv7()}/status`).set('Cookie', seller.cookies).send({ status: 'paid' });

			expect(res.status).toBe(expected);
		});
	});

	// Postgres only: a legacy hex id is an alias of a uuid, which Mongo does not have.
	it.skipIf(!POSTGRES)('reaches a product by its legacy hex id as well as by its uuid', async () => {
		const product = await data.products.create({ name: 'Imported', price: 1000, category: 'general', available: true, _id: HEX }, 4);
		expect(product._id).toBe(objectIdToUuidV7(HEX));

		const publicByHex = await request(app).get(`/api/products/${HEX}`);
		const publicByUuid = await request(app).get(`/api/products/${product._id}`);
		const movements = await request(app).get(`/api/admin/products/${HEX.toUpperCase()}/stock-movements`).set('Cookie', cookies);
		const adjust = await request(app).post(`/api/admin/products/${HEX}/stock-adjustments`).set('Cookie', cookies)
			.send({ mode: 'delta', value: 1, reason: 'count' });

		expect([publicByHex.status, publicByUuid.status, movements.status, adjust.status]).toEqual([200, 200, 200, 202]);
		expect(adjust.body.data.productId).toBe(product._id);
	});
});
