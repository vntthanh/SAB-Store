const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeProduct } = require('../helpers/factories');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const User = require('../../models/User');
const Account = require('../../models/Account');

function attachImport(app, cookies, payload) {
	const buffer = Buffer.from(JSON.stringify(payload));
	return request(app)
		.post('/api/admin/database/import')
		.set('Cookie', cookies)
		.attach('dataFile', buffer, { filename: 'backup.json', contentType: 'application/json' });
}

describe('POST /api/admin/database/import', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	// Phase 05 closed the hole where a client sets its own order total; a
	// restore file is just another untrusted client from that angle.
	it('recomputes order totalAmount from items, ignoring the file-supplied value', async () => {
		const { cookies } = await makeAdminSession(app);
		const product = await makeProduct({ price: 50000 });

		const payload = {
			data: {
				orders: [{
					orderCode: 'ORD0001',
					phoneNumber: '0900000000',
					studentId: 'SV001',
					fullName: 'Nguyen Van A',
					email: 'a@test.com',
					isDirectSale: false,
					status: 'confirmed',
					totalAmount: 1, // attacker-supplied — must never be honored
					items: [{ productId: product._id, productName: product.name, price: 50000, quantity: 2 }]
				}]
			}
		};

		const res = await attachImport(app, cookies, payload);

		expect(res.status).toBe(200);
		expect(res.body.results.orders.imported).toBe(1);

		const stored = await Order.findOne({ orderCode: 'ORD0001' });
		expect(stored.totalAmount).toBe(100000);
	});

	it('never creates a user or account from an import file, and reports why', async () => {
		const { cookies } = await makeAdminSession(app);
		const usersBefore = await User.countDocuments({});
		const accountsBefore = await Account.countDocuments({});

		const payload = {
			data: {
				users: [{ email: 'evil@test.local', username: 'evil', name: 'Evil', role: 'admin' }],
				accounts: [{ userId: 'forged', providerId: 'credential', accountId: 'evil@test.local', password: 'forged-hash' }]
			}
		};

		const res = await attachImport(app, cookies, payload);

		expect(res.status).toBe(200);
		expect(res.body.rejected.users).toEqual({ count: 1, reason: expect.any(String) });
		expect(res.body.rejected.accounts).toEqual({ count: 1, reason: expect.any(String) });
		expect(await User.countDocuments({})).toBe(usersBefore);
		expect(await Account.countDocuments({})).toBe(accountsBefore);
		expect(await User.findOne({ email: 'evil@test.local' })).toBeNull();
	});

	it('rejects a structurally malformed file before writing anything, even alongside a well-formed section', async () => {
		const { cookies } = await makeAdminSession(app);

		const payload = {
			data: {
				products: 'not-an-array', // structural violation
				orders: [{ orderCode: 'ORD9999', items: [] }] // well-formed on its own
			}
		};

		const res = await attachImport(app, cookies, payload);

		expect(res.status).toBe(400);
		expect(await Order.countDocuments({})).toBe(0);
		expect(await Product.countDocuments({})).toBe(0);
	});

	it('rejects invalid JSON before writing anything, with a correlation id and no stack trace', async () => {
		const { cookies } = await makeAdminSession(app);

		const res = await request(app)
			.post('/api/admin/database/import')
			.set('Cookie', cookies)
			.attach('dataFile', Buffer.from('{not valid json'), { filename: 'bad.json', contentType: 'application/json' });

		expect(res.status).toBe(400);
		expect(res.body).toHaveProperty('correlationId');
		expect(res.body).not.toHaveProperty('errorDetails');
		expect(JSON.stringify(res.body)).not.toMatch(/at Object|at process|\.js:\d+:\d+/);
	});

	it('ignores a file-supplied _id and lets Mongo assign a new one', async () => {
		const { cookies } = await makeAdminSession(app);
		const forgedId = 'this-is-not-a-real-mongo-id';

		const payload = {
			data: {
				products: [{ _id: forgedId, name: 'Imported Product', price: 20000, category: 'general' }]
			}
		};

		const res = await attachImport(app, cookies, payload);

		expect(res.status).toBe(200);
		expect(res.body.results.products.imported).toBe(1);

		const stored = await Product.findOne({ name: 'Imported Product' });
		expect(stored).not.toBeNull();
		expect(stored._id.toString()).not.toBe(forgedId);
	});

	it('per-record error output carries no stack trace or raw source record', async () => {
		const { cookies } = await makeAdminSession(app);

		const payload = {
			data: {
				products: [{ description: 'missing required name/price/category' }]
			}
		};

		const res = await attachImport(app, cookies, payload);

		expect(res.status).toBe(200);
		expect(res.body.results.products.errors).toBe(1);
		const entry = res.body.errorDetails.products[0];
		expect(entry).not.toHaveProperty('stack');
		expect(entry).not.toHaveProperty('data');
		expect(entry).toHaveProperty('error');
	});

	it('dedupes a re-imported order by orderCode instead of duplicating it', async () => {
		const { cookies } = await makeAdminSession(app);
		const payload = {
			data: {
				orders: [{
					orderCode: 'ORDDUP1',
					isDirectSale: true,
					status: 'confirmed',
					items: []
				}]
			}
		};

		const first = await attachImport(app, cookies, payload);
		expect(first.status).toBe(200);
		expect(first.body.results.orders.imported).toBe(1);

		const second = await attachImport(app, cookies, payload);
		expect(second.status).toBe(200);
		expect(second.body.results.orders.imported).toBe(0);
		expect(second.body.results.orders.skipped).toBe(1);
		expect(await Order.countDocuments({ orderCode: 'ORDDUP1' })).toBe(1);
	});

	it('rejects an unauthenticated request', async () => {
		const res = await request(app)
			.post('/api/admin/database/import')
			.attach('dataFile', Buffer.from('{"data":{}}'), { filename: 'x.json', contentType: 'application/json' });
		expect([401, 403]).toContain(res.status);
	});
});
