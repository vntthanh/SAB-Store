const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const Settings = require('../../models/Settings');

const PAYMENT_FIELDS = { bankNameId: 'MB', bankAccountId: '0123456789', prefixMessage: 'SAB' };

describe('store title setting', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	describe('GET /api/settings (public)', () => {
		it('returns the default title when no settings document exists', async () => {
			const res = await request(app).get('/api/settings');

			expect(res.status).toBe(200);
			expect(res.body.data).toEqual({ storeTitle: 'SAB Store' });
		});

		it('returns the default title for a document saved before the field existed', async () => {
			await Settings.collection.insertOne({ key: 'payment_config', ...PAYMENT_FIELDS });

			const res = await request(app).get('/api/settings');

			expect(res.body.data).toEqual({ storeTitle: 'SAB Store' });
		});

		it('exposes only the store title, never payment details', async () => {
			await Settings.create({ ...PAYMENT_FIELDS, storeTitle: 'Shop' });

			const res = await request(app).get('/api/settings');

			expect(Object.keys(res.body.data)).toEqual(['storeTitle']);
			expect(res.body.data.storeTitle).toBe('Shop');
		});
	});

	describe('GET /api/admin/settings', () => {
		it('reports the default title for a document saved before the field existed', async () => {
			const { cookies } = await makeAdminSession(app);
			await Settings.collection.insertOne({ key: 'payment_config', ...PAYMENT_FIELDS });

			const res = await request(app).get('/api/admin/settings').set('Cookie', cookies);

			expect(res.status).toBe(200);
			expect(res.body.data).toMatchObject({ ...PAYMENT_FIELDS, storeTitle: 'SAB Store' });
		});
	});

	describe('PUT /api/admin/settings', () => {
		it('rejects an anonymous caller', async () => {
			const res = await request(app)
				.put('/api/admin/settings')
				.send({ ...PAYMENT_FIELDS, storeTitle: 'Hacked' });

			expect(res.status).toBe(401);
		});

		it('lets an admin change the title, which the public endpoint then serves', async () => {
			const { cookies } = await makeAdminSession(app);

			const put = await request(app)
				.put('/api/admin/settings')
				.set('Cookie', cookies)
				.send({ ...PAYMENT_FIELDS, storeTitle: '  Cửa hàng SAB 2026  ' });

			expect(put.status).toBe(200);
			expect(put.body.data.storeTitle).toBe('Cửa hàng SAB 2026');

			const get = await request(app).get('/api/settings');
			expect(get.body.data.storeTitle).toBe('Cửa hàng SAB 2026');
		});

		it('keeps the current title when the field is omitted', async () => {
			const { cookies } = await makeAdminSession(app);
			await Settings.create({ ...PAYMENT_FIELDS, storeTitle: 'Kept' });

			const put = await request(app)
				.put('/api/admin/settings')
				.set('Cookie', cookies)
				.send({ ...PAYMENT_FIELDS, bankAccountId: '999' });

			expect(put.status).toBe(200);
			expect(put.body.data.storeTitle).toBe('Kept');
		});

		it.each([
			['blank', '   '],
			['too long', 'x'.repeat(61)],
			['non-string', { $ne: null }],
		])('rejects a %s title', async (_label, storeTitle) => {
			const { cookies } = await makeAdminSession(app);

			const res = await request(app)
				.put('/api/admin/settings')
				.set('Cookie', cookies)
				.send({ ...PAYMENT_FIELDS, storeTitle });

			expect(res.status).toBe(400);
			expect(await Settings.countDocuments()).toBe(0);
		});
	});
});
