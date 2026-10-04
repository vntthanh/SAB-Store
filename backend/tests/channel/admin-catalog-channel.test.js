/**
 * Admin product routes and database import/export carry salesChannel, and no
 * longer read or write the deprecated isActive flag.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeProduct, makeCombo, makeAdminSession } = require('../helpers/factories');
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');

describe('admin products: salesChannel', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	const newProduct = (extra = {}) => ({ name: 'Channel product', price: 10000, category: 'general', ...extra });

	it('creates with a valid salesChannel and defaults to "all"', async () => {
		const offline = await request(app).post('/api/admin/products').set('Cookie', cookies).send(newProduct({ salesChannel: 'offline' }));
		expect(offline.status).toBe(201);
		expect(offline.body.data.product.salesChannel).toBe('offline');

		const plain = await request(app).post('/api/admin/products').set('Cookie', cookies).send(newProduct({ name: 'Plain' }));
		expect(plain.body.data.product.salesChannel).toBe('all');
	});

	it('rejects an unknown salesChannel on create and update with 400, writing nothing', async () => {
		const create = await request(app).post('/api/admin/products').set('Cookie', cookies).send(newProduct({ salesChannel: 'xyz' }));
		expect(create.status).toBe(400);
		expect(await Product.countDocuments({})).toBe(0);

		const product = await makeProduct({ salesChannel: 'online', name: 'Before' });
		const update = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ salesChannel: 'xyz', name: 'After' });
		expect(update.status).toBe(400);

		const stored = await Product.findById(product._id);
		expect(stored.salesChannel).toBe('online');
		expect(stored.name).toBe('Before');
	});

	it('updates salesChannel', async () => {
		const product = await makeProduct({ salesChannel: 'all' });

		const res = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ salesChannel: 'offline' });

		expect(res.status).toBe(200);
		expect(res.body.data.product.salesChannel).toBe('offline');
	});

	it('ignores isActive in the body on create and update', async () => {
		const created = await request(app).post('/api/admin/products').set('Cookie', cookies).send(newProduct({ isActive: false }));
		expect(created.status).toBe(201);
		expect(created.body.data.product.isActive).toBe(true); // schema default, not the body

		const product = await makeProduct({ isActive: true });
		const updated = await request(app)
			.put(`/api/admin/products/${product._id}`)
			.set('Cookie', cookies)
			.send({ isActive: false });
		expect(updated.status).toBe(200);
		expect((await Product.findById(product._id)).isActive).toBe(true);
	});

	it('filters the admin list by channel; "all" includes legacy documents without the field', async () => {
		await makeProduct({ name: 'P online', salesChannel: 'online' });
		await makeProduct({ name: 'P offline', salesChannel: 'offline' });
		await makeProduct({ name: 'P both', salesChannel: 'all' });
		await Product.collection.insertOne({ name: 'P legacy', price: 1, category: 'general', available: true, stockQuantity: 0 });

		const names = async (query) => {
			const res = await request(app).get('/api/admin/products').query(query).set('Cookie', cookies);
			expect(res.status).toBe(200);
			return res.body.data.products.map((p) => p.name).sort();
		};

		expect(await names({ channel: 'online' })).toEqual(['P online']);
		expect(await names({ channel: 'offline' })).toEqual(['P offline']);
		expect(await names({ channel: 'all' })).toEqual(['P both', 'P legacy']);
		expect(await names({})).toEqual(['P both', 'P legacy', 'P offline', 'P online']);
		// The channel filter composes with the search $or instead of replacing it.
		expect(await names({ channel: 'all', search: 'legacy' })).toEqual(['P legacy']);
	});

	it('drops an operator-shaped channel filter instead of running it', async () => {
		await makeProduct({ name: 'Visible', salesChannel: 'offline' });

		const res = await request(app).get('/api/admin/products').query('channel[$ne]=x').set('Cookie', cookies);

		expect(res.status).toBe(200);
		expect(res.body.data.products.map((p) => p.name)).toContain('Visible');
	});
});

describe('admin dashboard stats by channel', () => {
	it('counts products per sales channel, legacy documents as "all"', async () => {
		const app = buildTestApp();
		const { cookies } = await makeAdminSession(app);
		await makeProduct({ salesChannel: 'online' });
		await makeProduct({ salesChannel: 'online' });
		await makeProduct({ salesChannel: 'offline' });
		await Product.collection.insertOne({ name: 'Legacy', price: 1, category: 'general', available: true, stockQuantity: 0 });

		const res = await request(app).get('/api/admin/dashboard/stats').set('Cookie', cookies);

		expect(res.status).toBe(200);
		expect(res.body.data.products.byChannel).toEqual({ all: 1, online: 2, offline: 1 });
	});
});

describe('database import/export: salesChannel', () => {
	let app;
	let cookies;

	beforeEach(async () => {
		app = buildTestApp();
		({ cookies } = await makeAdminSession(app));
	});

	const attachImport = (payload) =>
		request(app)
			.post('/api/admin/database/import')
			.set('Cookie', cookies)
			.attach('dataFile', Buffer.from(JSON.stringify(payload)), { filename: 'backup.json', contentType: 'application/json' });

	it('imports a valid salesChannel for products and combos', async () => {
		const res = await attachImport({
			data: {
				products: [{ name: 'Imported offline', price: 5, category: 'general', salesChannel: 'offline' }],
				combos: [{
					name: 'Imported online combo',
					price: 5,
					salesChannel: 'online',
					categoryRequirements: [{ category: 'general', quantity: 1 }]
				}]
			}
		});

		expect(res.status).toBe(200);
		expect((await Product.findOne({ name: 'Imported offline' })).salesChannel).toBe('offline');
		expect((await Combo.findOne({ name: 'Imported online combo' })).salesChannel).toBe('online');
	});

	it('still accepts an older file that has no salesChannel and still carries isActive', async () => {
		const res = await attachImport({
			data: { products: [{ name: 'Old backup item', price: 5, category: 'general', isActive: true, available: true }] }
		});

		expect(res.status).toBe(200);
		const stored = await Product.findOne({ name: 'Old backup item' });
		expect(stored.salesChannel).toBe('all');
	});

	it('rejects a file with an unknown salesChannel as a structure error and writes nothing', async () => {
		const res = await attachImport({
			data: {
				products: [{ name: 'Fine', price: 5, category: 'general' }, { name: 'Bad channel', price: 5, category: 'general', salesChannel: 'xyz' }],
				combos: [{ name: 'Bad combo', price: 5, salesChannel: 'pos', categoryRequirements: [{ category: 'general', quantity: 1 }] }]
			}
		});

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('INVALID_FORMAT');
		expect(res.body.problems.join(' ')).toMatch(/salesChannel/);
		expect(await Product.countDocuments({})).toBe(0);
		expect(await Combo.countDocuments({})).toBe(0);
	});

	it('exports salesChannel with each product and combo', async () => {
		await makeProduct({ name: 'Exported product', salesChannel: 'online' });
		await makeCombo({ name: 'Exported combo', salesChannel: 'offline' });

		const res = await request(app).get('/api/admin/database/export').set('Cookie', cookies);

		expect(res.status).toBe(200);
		expect(res.body.data.products.find((p) => p.name === 'Exported product').salesChannel).toBe('online');
		expect(res.body.data.combos.find((c) => c.name === 'Exported combo').salesChannel).toBe('offline');
	});
});
