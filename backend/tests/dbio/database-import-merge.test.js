const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeProduct, makeCombo, makeOrder } = require('../helpers/factories');
const {
	findOrderByCode, findProduct, findCombo, findProductByName, countRows, deleteAllRows,
	listCombos, countAuthRows, listOrders, movements, stockOf
} = require('../helpers/db');
const { applyPendingMovements } = require('../helpers/stock');
const { recordAppliedOpening } = require('../../services/stock-ledger');
const { seedStore } = require('./snapshot-fixture');
const { POSTGRES } = require('../helpers/backend');
const { normalizeRecordId } = require('../../data/ids');

const importFile = (app, cookies, payload) => request(app)
	.post('/api/admin/database/import')
	.set('Cookie', cookies)
	.attach('dataFile', Buffer.from(JSON.stringify(payload)), { filename: 'backup.json', contentType: 'application/json' });

const exportFile = async (app, cookies) => (await request(app).get('/api/admin/database/export').set('Cookie', cookies)).body;

describe('POST /api/admin/database/import (merge) with a backup file', () => {
	let app;
	let cookies;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		({ cookies } = await makeAdminSession(app));
	});

	it('imports two combos that share a name', async () => {
		const { combos } = await seedStore('a');
		const file = await exportFile(app, cookies);
		await deleteAllRows('product', 'combo', 'order', 'settings');

		const res = await importFile(app, cookies, file);

		expect(res.status).toBe(200);
		expect(res.body.results.combos).toEqual({ imported: 2, skipped: 0, errors: 0, skippedByReason: {} });
		const stored = await listCombos();
		expect(stored.map((c) => c._id).sort()).toEqual([String(combos.comboA._id), String(combos.comboB._id)].sort());
		expect(stored.map((c) => c.name)).toEqual([combos.comboA.name, combos.comboA.name]);
	});

	it('keeps an order\'s history, notes and edit history when the order is new, but never its stock flag', async () => {
		const { orders } = await seedStore('a');
		const file = await exportFile(app, cookies);
		expect(file.data.orders.some((o) => o.stockDeducted === true)).toBe(true);
		const original = Object.fromEntries((await listOrders()).map((o) => [o.orderCode, o]));
		const orderMovements = () => movements({ type: ['order', 'order_cancel', 'order_edit'] });
		await deleteAllRows('product', 'combo', 'order', 'settings');
		const movementsBefore = await orderMovements();

		const res = await importFile(app, cookies, file);

		expect(res.status).toBe(200);
		expect(res.body.results.orders.imported).toBe(4);
		for (const order of Object.values(orders)) {
			const stored = await findOrderByCode(order.orderCode);
			const expected = original[order.orderCode];
			expect(stored.statusHistory.map(({ _id, ...rest }) => rest)).toEqual(expected.statusHistory.map(({ _id, ...rest }) => rest));
			expect(stored.internalNotes).toEqual(expected.internalNotes);
			expect(stored.itemsHistory).toEqual(expected.itemsHistory);
			expect(stored.itemsRevision).toBe(expected.itemsRevision);
			expect(stored.stockDeducted).toBe(false);
			expect(stored.totalAmount).toBe(expected.totalAmount);
		}
		expect(await orderMovements()).toEqual(movementsBefore);
	});

	it('does not give stock back when a merged order that claimed to be deducted is cancelled', async () => {
		const product = await makeProduct({ name: 'Counted once', price: 10000, stockQuantity: 10 });
		await recordAppliedOpening({ productId: product._id, quantity: 10, createdBy: 'seed', reason: 'seed' });
		const file = {
			data: {
				orders: [{
					orderCode: 'MERGE1',
					studentId: '24120001',
					fullName: 'Nguyen Van A',
					email: 'a@example.com',
					phoneNumber: '0987654321',
					status: 'confirmed',
					stockDeducted: true,
					items: [{ productId: String(product._id), productName: product.name, price: 10000, quantity: 3 }]
				}]
			}
		};

		const imported = await importFile(app, cookies, file);
		expect(imported.status).toBe(200);
		expect(imported.body.results.orders.imported).toBe(1);
		expect(imported.body.droppedFields.orders.stockDeducted).toBe(1);
		const merged = await findOrderByCode('MERGE1');
		expect(merged.stockDeducted).toBe(false);

		const cancelled = await request(app).put(`/api/admin/orders/${merged._id}`).set('Cookie', cookies).send({ status: 'cancelled' });

		expect(cancelled.status).toBe(200);
		await applyPendingMovements();
		expect(await stockOf(product._id)).toBe(10);
		expect(await movements({ type: 'order_cancel' })).toEqual([]);
	});

	it('dedupes combos by id, falls back to names that existed before the import, and keeps same-name combos of one file', async () => {
		const existing = await makeCombo({ name: 'Already here', price: 20000 });
		const requirements = [{ category: 'general', quantity: 1 }];
		const file = {
			data: {
				combos: [
					{ _id: String(existing._id), name: 'Already here', price: 1, categoryRequirements: requirements },
					{ _id: '507f1f77bcf86cd799439021', name: 'Already here', price: 2, categoryRequirements: requirements },
					{ name: 'Already here', price: 3, categoryRequirements: requirements },
					{ name: 'Brand new twin', price: 4, categoryRequirements: requirements },
					{ name: 'Brand new twin', price: 5, categoryRequirements: requirements },
					{ _id: '507f1f77bcf86cd799439022', name: 'Brand new twin', price: 6, categoryRequirements: requirements }
				]
			}
		};

		const res = await importFile(app, cookies, file);

		expect(res.status).toBe(200);
		expect(res.body.results.combos).toEqual({ imported: 3, skipped: 3, errors: 0, skippedByReason: { id_exists: 1, name_exists: 2 } });
		const stored = await listCombos();
		expect(stored.map((c) => c.name).sort()).toEqual(['Already here', 'Brand new twin', 'Brand new twin', 'Brand new twin']);
		expect(stored.find((c) => c.name === 'Already here').price).toBe(20000);
	});

	it('never changes a record that already exists, and says why each record was skipped', async () => {
		const product = await makeProduct({ name: 'Existing product', price: 10000, stockQuantity: 0 });
		const combo = await makeCombo({ name: 'Existing combo', price: 20000 });
		const order = await makeOrder({ orderCode: 'EXIST1', items: [], totalAmount: 0, additionalNote: 'original' });
		const file = {
			data: {
				products: [
					{ _id: String(product._id), name: 'Renamed in file', price: 99999, category: 'general' },
					{ name: 'Existing product', price: 88888, category: 'general' }
				],
				combos: [
					{ _id: String(combo._id), name: 'Different name', price: 1, categoryRequirements: [{ category: 'general', quantity: 1 }] },
					{ name: 'Existing combo', price: 2, categoryRequirements: [{ category: 'general', quantity: 1 }] }
				],
				orders: [{ orderCode: 'EXIST1', isDirectSale: true, status: 'paid', additionalNote: 'from file', items: [] }]
			}
		};

		const res = await importFile(app, cookies, file);

		expect(res.status).toBe(200);
		expect(res.body.results.products).toEqual({ imported: 0, skipped: 2, errors: 0, skippedByReason: { id_exists: 1, name_exists: 1 } });
		expect(res.body.results.combos).toEqual({ imported: 0, skipped: 2, errors: 0, skippedByReason: { id_exists: 1, name_exists: 1 } });
		expect(res.body.results.orders).toEqual({ imported: 0, skipped: 1, errors: 0, skippedByReason: { order_code_exists: 1 } });
		expect(await findProduct(product._id)).toEqual(expect.objectContaining({ name: 'Existing product', price: 10000 }));
		expect(await findCombo(combo._id)).toEqual(expect.objectContaining({ name: 'Existing combo', price: 20000 }));
		expect(await findOrderByCode('EXIST1')).toEqual(expect.objectContaining({ _id: String(order._id), status: 'confirmed', additionalNote: 'original' }));
		expect(await countRows('product')).toBe(1);
		expect(await countRows('combo')).toBe(1);
		expect(await countRows('order')).toBe(1);
	});

	it('reports the fields it left behind and the sections it did not merge', async () => {
		await seedStore('a');
		const file = await exportFile(app, cookies);
		await deleteAllRows('product', 'combo', 'order', 'settings');

		const res = await importFile(app, cookies, file);

		expect(res.status).toBe(200);
		expect(res.body.ignored.stockMovements.count).toBe(8);
		expect(res.body.ignored.settings.count).toBe(1);
		// A Postgres row has no storage version key, so it is only dropped from Mongo-shaped files.
		expect(res.body.droppedFields.orders).toEqual(expect.objectContaining({ createdAt: 4, updatedAt: 4, _id: 4, ...(POSTGRES ? {} : { __v: 4 }) }));
		expect(res.body.droppedFields.products).toEqual(expect.objectContaining({ slug: 3, createdAt: 3 }));
		expect(await countRows('settings')).toBe(0);
	});

	it('refuses to write login sections of any kind and reports them', async () => {
		// The first authenticated request of a database mints the token signing key. Take
		// the snapshot after it, or a store that was just emptied counts it as written by the import.
		await request(app).get('/api/auth/get-session').set('Cookie', cookies);
		const before = { user: await countRows('user'), account: await countRows('account'), session: await countAuthRows('session'), jwks: await countAuthRows('jwks') };

		const res = await importFile(app, cookies, {
			data: {
				users: [{ email: 'evil@test.local' }],
				accounts: [{ password: 'x' }],
				sessions: [{ token: 'x' }, { token: 'y' }],
				jwks: [{ privateKey: 'x' }]
			}
		});

		expect(res.status).toBe(200);
		expect(Object.fromEntries(Object.entries(res.body.rejected).map(([k, v]) => [k, v.count]))).toEqual({ users: 1, accounts: 1, sessions: 2, jwks: 1 });
		expect({ user: await countRows('user'), account: await countRows('account'), session: await countAuthRows('session'), jwks: await countAuthRows('jwks') })
			.toEqual(before);
	});

	it('names the field a record\'s rules refused, per collection', async () => {
		const res = await importFile(app, cookies, {
			data: {
				products: [{ name: 'No price', category: 'general' }],
				combos: [{ name: 'Negative', price: -1, categoryRequirements: [{ category: 'general', quantity: 1 }] }],
				orders: [{ orderCode: 'BADST1', fullName: 'X', studentId: 'S1', email: 'x@example.com', phoneNumber: '0912345678', items: [], status: 'weird' }]
			}
		});

		expect(res.status).toBe(200);
		expect(res.body.hasErrors).toBe(true);
		expect(res.body.errorDetails.products[0].error).toMatch(/^Product validation failed: price: /);
		expect(res.body.errorDetails.combos[0].error).toMatch(/^Combo validation failed: price: /);
		expect(res.body.errorDetails.orders[0].error).toMatch(/^Order validation failed: status: /);
	});

	it('still accepts a v1 export (no stock movements, no settings, no format version)', async () => {
		const product = await makeProduct({ name: 'Old file product' });
		const v1 = {
			metadata: { exportDate: '2026-09-01T00:00:00.000Z', exportedBy: 'admin@test.local', version: '2.0', collections: { products: 1, combos: 0, orders: 0 } },
			data: { products: [{ _id: '507f1f77bcf86cd799439011', name: 'From v1', price: 1000, category: 'general' }], combos: [], orders: [] }
		};

		const res = await importFile(app, cookies, v1);

		expect(res.status).toBe(200);
		expect(res.body.results.products.imported).toBe(1);
		expect(res.body.ignored).toBeUndefined();
		// A legacy hex id is stored under its uuid on Postgres.
		expect((await findProductByName('From v1'))._id).toBe(normalizeRecordId('507f1f77bcf86cd799439011'));
		expect(await findProduct(product._id)).not.toBeNull();
	});
});
