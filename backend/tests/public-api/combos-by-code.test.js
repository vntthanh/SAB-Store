const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeAdminSession } = require('../helpers/factories');
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');

describe('GET /api/combos/by-code/:code', () => {
	let app;

	beforeAll(() => Promise.all([Product.init(), Combo.init()]));
	beforeEach(() => {
		app = buildTestApp();
	});

	it('lists only online products per merged requirement, with no stock fields', async () => {
		const online = await makeProduct({ salesChannel: 'online', stockQuantity: 9 });
		await makeProduct({ salesChannel: 'offline' });
		await makeProduct({ available: false });
		const combo = await makeCombo({
			salesChannel: 'online',
			categoryRequirements: [{ category: 'general', quantity: 1 }, { category: 'general', quantity: 2 }]
		});

		const res = await request(app).get(`/api/combos/by-code/${combo.publicCode}`);

		expect(res.status).toBe(200);
		expect(res.headers['cache-control']).toBe('public, max-age=60');
		const { data } = res.body;
		expect(data.path).toBe(`/c/${combo.publicCode}/${combo.slug}`);
		expect(data.requirements).toHaveLength(1);
		expect(data.requirements[0]).toMatchObject({ category: 'general', quantity: 3 });
		expect(data.requirements[0].products.map((p) => p._id)).toEqual([online._id.toString()]);
		expect(JSON.stringify(res.body)).not.toMatch(/stockQuantity|inStock/);
	});

	it('still answers 200 with empty product lists when no online product fits', async () => {
		const combo = await makeCombo({
			name: 'Lonely combo',
			price: 123000,
			salesChannel: 'online',
			categoryRequirements: [{ category: 'general', quantity: 1 }]
		});
		await makeProduct({ salesChannel: 'offline' });

		const res = await request(app).get(`/api/combos/by-code/${combo.publicCode}`);

		expect(res.status).toBe(200);
		expect(res.body.data).toMatchObject({ name: 'Lonely combo', price: 123000 });
		expect(res.body.data.requirements).toEqual([{ category: 'general', quantity: 1, products: [] }]);
	});

	it('answers 404 for inactive, counter-only, unknown and malformed codes', async () => {
		const inactive = await makeCombo({ salesChannel: 'online', isActive: false });
		const counterOnly = await makeCombo({ salesChannel: 'offline' });

		for (const code of [inactive.publicCode, counterOnly.publicCode, 'ZZZZZZZZ', '%24ne']) {
			const res = await request(app).get(`/api/combos/by-code/${code}`);
			expect(res.status).toBe(404);
		}
	});

	it('keeps GET /api/combos/:id admin-only', async () => {
		const combo = await makeCombo({ salesChannel: 'online' });

		const anonymous = await request(app).get(`/api/combos/${combo._id}`);
		expect([401, 403]).toContain(anonymous.status);

		const { cookies } = await makeAdminSession(app);
		const admin = await request(app).get(`/api/combos/${combo._id}`).set('Cookie', cookies);
		expect(admin.status).toBe(200);
	});
});
