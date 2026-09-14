const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeProduct, makeCombo } = require('../helpers/factories');
const Product = require('../../models/Product');
const Combo = require('../../models/Combo');
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

	// F10 — this router had no multer error handler, unlike routes/upload.js.
	// A rejected fileFilter error (wrong mimetype) reached Express's global
	// error handler as an opaque INTERNAL_SERVER_ERROR 500 instead of the
	// explicit 400 every other rejection on this endpoint returns.
	it('rejects a non-JSON file with an explicit 400 instead of a generic 500', async () => {
		const { cookies } = await makeAdminSession(app);

		const res = await request(app)
			.post('/api/admin/database/import')
			.set('Cookie', cookies)
			.attach('dataFile', Buffer.from('not json at all'), { filename: 'backup.txt', contentType: 'text/plain' });

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('INVALID_FILE_TYPE');
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

	// F1 + F2 — disaster recovery must reconstruct the exact original data.
	// Before the fix: computeOrderTotal() summed price*quantity over EVERY
	// item, inflating a combo order's total by exactly the combo's savings
	// (F1), and products always got a fresh `_id` on import while
	// items[].productId was imported verbatim, so the restored order's item
	// pointed at a product that no longer existed (F2).
	it('round-trips a combo order through export then import: same totalAmount/comboInfo, and items[].productId still resolves', async () => {
		const { cookies } = await makeAdminSession(app);
		const combo = await makeCombo({
			name: 'Combo Round Trip',
			price: 150000,
			categoryRequirements: [{ category: 'combo-roundtrip', quantity: 2 }]
		});
		const product = await makeProduct({ category: 'combo-roundtrip', price: 100000 });

		await Order.create({
			orderCode: 'ORDCMB1',
			phoneNumber: '0900000001',
			studentId: 'SV555',
			fullName: 'Combo Buyer',
			email: 'combo@test.com',
			isDirectSale: false,
			status: 'confirmed',
			items: [{
				productId: product._id,
				productName: product.name,
				price: product.price, // combo line keeps its original per-unit price...
				quantity: 2,
				fromCombo: true,
				comboId: combo._id,
				comboName: combo.name
			}],
			totalAmount: 150000, // ...but the order total is the combo's discounted price, NOT 2*100000
			comboInfo: {
				comboId: combo._id,
				comboName: combo.name,
				savings: 50000,
				originalTotal: 200000,
				finalTotal: 150000
			}
		});

		const exportRes = await request(app).get('/api/admin/database/export').set('Cookie', cookies);
		expect(exportRes.status).toBe(200);

		// Simulate a disaster-recovery restore into an empty database. Leaves
		// the admin session's own user/account/session rows untouched — only
		// the business-data collections that /export and /import cover.
		await Order.deleteMany({});
		await Product.deleteMany({});
		await Combo.deleteMany({});

		const buffer = Buffer.from(JSON.stringify(exportRes.body));
		const importRes = await request(app)
			.post('/api/admin/database/import')
			.set('Cookie', cookies)
			.attach('dataFile', buffer, { filename: 'restore.json', contentType: 'application/json' });

		expect(importRes.status).toBe(200);
		expect(importRes.body.results.products.imported).toBe(1);
		expect(importRes.body.results.combos.imported).toBe(1);
		expect(importRes.body.results.orders.imported).toBe(1);

		const restoredProduct = await Product.findOne({ name: product.name });
		expect(restoredProduct).not.toBeNull();
		// F2: the product keeps its original _id instead of getting a fresh one.
		expect(restoredProduct._id.toString()).toBe(product._id.toString());

		const restoredOrder = await Order.findOne({ orderCode: 'ORDCMB1' });
		// F1: total is the original combo-discounted amount, not Σ(price×qty).
		expect(restoredOrder.totalAmount).toBe(150000);
		expect(restoredOrder.comboInfo.finalTotal).toBe(150000);
		expect(restoredOrder.comboInfo.savings).toBe(50000);

		// F2: items[].productId still resolves to a real product after restore.
		const populated = await Order.findOne({ orderCode: 'ORDCMB1' }).populate('items.productId', 'name');
		expect(populated.items[0].productId).not.toBeNull();
		expect(populated.items[0].productId.name).toBe(product.name);
	});

	it('honors a well-formed file-supplied product _id so order items keep resolving (F2)', async () => {
		const { cookies } = await makeAdminSession(app);
		const realId = '507f1f77bcf86cd799439011';

		const payload = {
			data: {
				products: [{ _id: realId, name: 'Preserved Id Product', price: 20000, category: 'general' }]
			}
		};

		const res = await attachImport(app, cookies, payload);

		expect(res.status).toBe(200);
		expect(res.body.results.products.imported).toBe(1);

		const stored = await Product.findOne({ name: 'Preserved Id Product' });
		expect(stored).not.toBeNull();
		expect(stored._id.toString()).toBe(realId);
	});

	it('still recomputes a non-combo order\'s total from items, ignoring the file-supplied value, when comboInfo is absent', async () => {
		const { cookies } = await makeAdminSession(app);
		const product = await makeProduct({ price: 30000 });

		const payload = {
			data: {
				orders: [{
					orderCode: 'ORDNC001',
					isDirectSale: true,
					status: 'paid',
					totalAmount: 1, // attacker/typo-supplied — must still be ignored
					items: [{ productId: product._id, productName: product.name, price: 30000, quantity: 2 }]
				}]
			}
		};

		const res = await attachImport(app, cookies, payload);

		expect(res.status).toBe(200);
		expect(res.body.results.orders.imported).toBe(1);

		const stored = await Order.findOne({ orderCode: 'ORDNC001' });
		expect(stored.totalAmount).toBe(60000);
	});
});
