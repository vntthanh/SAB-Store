/**
 * Combo routes honour the sales channel: /active and /pricing take an optional
 * channel (default online); POST/PUT accept salesChannel from admins only.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeAdminSession } = require('../helpers/factories');
const Combo = require('../../models/Combo');

describe('GET /api/combos/active', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('defaults to the online channel', async () => {
		const online = await makeCombo({ name: 'Web combo', salesChannel: 'online' });
		const offline = await makeCombo({ name: 'Counter combo', salesChannel: 'offline' });
		const both = await makeCombo({ name: 'Both combo', salesChannel: 'all' });

		const res = await request(app).get('/api/combos/active');

		const names = res.body.data.combos.map((c) => c.name);
		expect(res.status).toBe(200);
		expect(names).toEqual(expect.arrayContaining([online.name, both.name]));
		expect(names).not.toContain(offline.name);
	});

	it('?channel=offline returns counter combos', async () => {
		const online = await makeCombo({ name: 'Web combo', salesChannel: 'online' });
		const offline = await makeCombo({ name: 'Counter combo', salesChannel: 'offline' });

		const res = await request(app).get('/api/combos/active').query({ channel: 'offline' });

		const names = res.body.data.combos.map((c) => c.name);
		expect(names).toContain(offline.name);
		expect(names).not.toContain(online.name);
	});

	it('falls back to online for an unknown channel value instead of erroring', async () => {
		const offline = await makeCombo({ name: 'Counter combo', salesChannel: 'offline' });

		const res = await request(app).get('/api/combos/active').query({ channel: 'pos' });

		expect(res.status).toBe(200);
		expect(res.body.data.combos.map((c) => c.name)).not.toContain(offline.name);
	});

	it('treats a legacy combo without the field as "all"', async () => {
		await Combo.collection.insertOne({
			name: 'Legacy combo',
			price: 1000,
			categoryRequirements: [{ category: 'general', quantity: 1 }],
			isActive: true,
			priority: 0
		});

		for (const channel of ['online', 'offline']) {
			const res = await request(app).get('/api/combos/active').query({ channel });
			expect(res.body.data.combos.map((c) => c.name)).toContain('Legacy combo');
		}
	});
});

describe('POST /api/combos/pricing (channel)', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	async function cart(productOverrides = {}, comboOverrides = {}) {
		const a = await makeProduct({ category: 'lanyard', price: 100000 });
		const b = await makeProduct({ category: 'sticker', price: 50000, ...productOverrides });
		await makeCombo({
			price: 120000,
			categoryRequirements: [
				{ category: 'lanyard', quantity: 1 },
				{ category: 'sticker', quantity: 1 }
			],
			...comboOverrides
		});
		return [
			{ productId: a._id.toString(), quantity: 1 },
			{ productId: b._id.toString(), quantity: 1 }
		];
	}

	it('defaults to online and refuses a cart holding a product not sold online', async () => {
		const items = await cart({ salesChannel: 'offline' });

		const res = await request(app).post('/api/combos/pricing').send({ items });

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('PRODUCT_CHANNEL_MISMATCH');
	});

	it('prices an online-only product online, and rejects it at the counter', async () => {
		const items = await cart({ salesChannel: 'online' });

		const online = await request(app).post('/api/combos/pricing').send({ items, channel: 'online' });
		expect(online.body.data.totalAmount).toBe(120000);

		const offline = await request(app).post('/api/combos/pricing').send({ items, channel: 'offline' });
		expect(offline.status).toBe(400);
	});

	// The order half is in expected-total.test.js.
	it('does not apply an online-only combo to the offline preview', async () => {
		const items = await cart({}, { salesChannel: 'online' });

		const offline = await request(app).post('/api/combos/pricing').send({ items, channel: 'offline' });
		expect(offline.body.data.comboInfo).toBeNull();
		expect(offline.body.data.totalAmount).toBe(150000);

		const online = await request(app).post('/api/combos/pricing').send({ items });
		expect(online.body.data.comboInfo.combos).toHaveLength(1);
		expect(online.body.data.totalAmount).toBe(120000);
	});

	it('keeps the legacy summary object that pre-deploy seller tabs read', async () => {
		const items = await cart({}, { salesChannel: 'online' });

		const res = await request(app).post('/api/combos/pricing').send({ items });

		expect(res.body.data.summary).toEqual({ originalTotal: 150000, totalSavings: 30000, finalTotal: 120000 });
	});

	it('applies an offline-only combo to the offline preview only', async () => {
		const items = await cart({}, { salesChannel: 'offline' });

		expect((await request(app).post('/api/combos/pricing').send({ items, channel: 'offline' })).body.data.totalAmount).toBe(120000);
		expect((await request(app).post('/api/combos/pricing').send({ items, channel: 'online' })).body.data.totalAmount).toBe(150000);
	});

	it('treats an unknown channel as online instead of erroring', async () => {
		const items = await cart({}, { salesChannel: 'offline' });

		const res = await request(app).post('/api/combos/pricing').send({ items, channel: 'pos' });

		expect(res.status).toBe(200);
		expect(res.body.data.totalAmount).toBe(150000);
	});
});

describe('admin combo create/update salesChannel', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
		await makeProduct({ category: 'general' }); // POST validates categories against existing products
	});

	const body = (extra = {}) => ({
		name: 'Channel combo',
		price: 100,
		categoryRequirements: [{ category: 'general', quantity: 1 }],
		...extra
	});

	it('stores a valid salesChannel on create and defaults to "all"', async () => {
		const created = await request(app).post('/api/combos').set('Cookie', cookies).send(body({ salesChannel: 'offline' }));
		expect(created.status).toBe(201);
		expect(created.body.data.combo.salesChannel).toBe('offline');

		const defaulted = await request(app).post('/api/combos').set('Cookie', cookies).send(body({ name: 'Default combo' }));
		expect(defaulted.status).toBe(201);
		expect(defaulted.body.data.combo.salesChannel).toBe('all');
	});

	it('rejects an unknown salesChannel on create with 400 and writes nothing', async () => {
		const res = await request(app).post('/api/combos').set('Cookie', cookies).send(body({ salesChannel: 'xyz' }));

		expect(res.status).toBe(400);
		expect(await Combo.countDocuments({})).toBe(0);
	});

	it('updates salesChannel, and rejects an unknown one with 400 leaving the value alone', async () => {
		const combo = await makeCombo({ salesChannel: 'all' });

		const ok = await request(app).put(`/api/combos/${combo._id}`).set('Cookie', cookies).send({ salesChannel: 'online' });
		expect(ok.status).toBe(200);
		expect(ok.body.data.combo.salesChannel).toBe('online');

		const bad = await request(app).put(`/api/combos/${combo._id}`).set('Cookie', cookies).send({ salesChannel: 'xyz' });
		expect(bad.status).toBe(400);
		expect((await Combo.findById(combo._id)).salesChannel).toBe('online');
	});

	it('rejects an operator-shaped salesChannel instead of passing it through', async () => {
		const combo = await makeCombo();

		const res = await request(app).put(`/api/combos/${combo._id}`).set('Cookie', cookies).send({ salesChannel: { $ne: 'all' } });

		expect(res.status).toBe(400);
	});

	it('returns salesChannel in the admin list', async () => {
		await makeCombo({ name: 'Listed', salesChannel: 'offline' });

		const res = await request(app).get('/api/combos').set('Cookie', cookies);

		expect(res.body.data.combos.find((c) => c.name === 'Listed').salesChannel).toBe('offline');
	});
});
