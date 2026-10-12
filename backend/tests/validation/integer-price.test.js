/**
 * Prices are whole VND. A fractional price would make every order total
 * fractional, while a client can only echo an integer total back.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeAdminSession } = require('../helpers/factories');
const { countRows, findProduct, findCombo } = require('../helpers/db');

const MESSAGE = 'Giá phải là số nguyên (VND)';

describe('integer prices on the admin routes', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	it('rejects a fractional product price on create and update with 400', async () => {
		const create = await request(app)
			.post('/api/admin/products')
			.set('Cookie', cookies)
			.send({ name: 'Fraction', price: 10.5, category: 'general' });
		expect(create.status).toBe(400);
		expect(create.body.message).toContain(MESSAGE);
		expect(await countRows('product')).toBe(0);

		const product = await makeProduct({ price: 1000 });
		const update = await request(app).put(`/api/admin/products/${product._id}`).set('Cookie', cookies).send({ price: 10.5 });
		expect(update.status).toBe(400);
		expect((await findProduct(product._id)).price).toBe(1000);
	});

	it('rejects a fractional combo price on create and update with 400', async () => {
		await makeProduct({ category: 'general' });
		const create = await request(app)
			.post('/api/combos')
			.set('Cookie', cookies)
			.send({ name: 'Fraction', price: 10.5, categoryRequirements: [{ category: 'general', quantity: 1 }] });
		expect(create.status).toBe(400);
		expect(create.body.message).toContain(MESSAGE);

		const combo = await makeCombo({ price: 1000 });
		const update = await request(app).put(`/api/combos/${combo._id}`).set('Cookie', cookies).send({ price: 10.5 });
		expect(update.status).toBe(400);
		expect((await findCombo(combo._id)).price).toBe(1000);
	});
});
