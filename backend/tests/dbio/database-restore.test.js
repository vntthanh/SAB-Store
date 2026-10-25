const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeSellerSession, makeProduct } = require('../helpers/factories');
const {
	findOrderRaw, findProduct, countRows, deleteAllRows, isRowId,
	failNextOrderBulkInsert, findAuthRows, countAuthRows, movements, findSettings
} = require('../helpers/db');
const stockQueue = require('../../queues/stock-queue');
const databaseRoutes = require('../../routes/admin/database');
const { POSTGRES } = require('../helpers/backend');
const { seedStore, readStore } = require('./snapshot-fixture');

const PHRASE = 'KHOI PHUC';
// Postgres exports the storefront sections too; its empty store still holds the default storefront.
const SECTIONS = ['products', 'combos', 'orders', 'stockMovements', 'settings', ...(POSTGRES ? ['storefronts', 'storefrontAccessRules', 'emailLists', 'emailListEntries'] : [])];
const EMPTY_STORE_COUNTS = Object.fromEntries(SECTIONS.map((s) => [s, s === 'storefronts' ? 1 : 0]));

const exportFile = async (app, cookies) => {
	const res = await request(app).get('/api/admin/database/export').set('Cookie', cookies);
	expect(res.status).toBe(200);
	return res.body;
};

// `confirmation` null sends no phrase at all.
const restore = (app, cookies, file, confirmation = PHRASE) => {
	const call = request(app).post('/api/admin/database/restore').set('Cookie', cookies);
	if (confirmation !== null) call.field('confirmation', confirmation);
	if (file !== undefined) call.attach('dataFile', Buffer.from(JSON.stringify(file)), { filename: 'backup.json', contentType: 'application/json' });
	return call;
};

const withoutExportedAt = ({ metadata, data }) => ({ metadata: { ...metadata, exportedAt: undefined }, data });

const emptyStore = () => deleteAllRows('product', 'combo', 'order', 'settings');

describe('POST /api/admin/database/restore', () => {
	let app;
	let cookies;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		({ cookies } = await makeAdminSession(app));
	});

	describe('faithful round trip', () => {
		it('exports, empties, restores and exports again to an identical file and identical rows', async () => {
			const seeded = await seedStore('a');
			const first = await exportFile(app, cookies);
			const rowsBefore = await readStore();
			expect(first.metadata.collections).toEqual({ products: 3, combos: 2, orders: 4, stockMovements: 8, settings: 1, ...(POSTGRES && { storefronts: 1, storefrontAccessRules: 0, emailLists: 0, emailListEntries: 0 }) });

			await emptyStore();
			expect(await countRows('order')).toBe(0);

			const res = await restore(app, cookies, first);

			expect(res.status).toBe(200);
			expect(res.body.ok).toBe(true);
			expect(res.body.restored).toEqual({ products: 3, combos: 2, orders: 4, stockMovements: 8, settings: 1, ...(POSTGRES && { storefronts: 1, storefrontAccessRules: 0, emailLists: 0, emailListEntries: 0 }) });
			const second = await exportFile(app, cookies);
			expect(withoutExportedAt(second)).toEqual(withoutExportedAt(first));
			expect(await readStore()).toEqual(rowsBefore);

			// The two combos that share a name both came back.
			expect(await countRows('combo', { name: seeded.combos.comboA.name })).toBe(2);
		});

		it('keeps order history, ids and timestamps that a merge import used to drop', async () => {
			const { orders } = await seedStore('a');
			const file = await exportFile(app, cookies);
			await emptyStore();

			expect((await restore(app, cookies, file)).status).toBe(200);

			const cancelled = await findOrderRaw(orders.cancelled._id);
			expect(String(cancelled._id)).toBe(String(orders.cancelled._id));
			expect(cancelled.statusHistory.map((h) => h.status)).toEqual(['confirmed', 'cancelled']);
			expect(cancelled.statusHistory[1].note).toBe('gọi không được');
			expect(cancelled.stockDeducted).toBe(false);
			expect(cancelled.createdAt).toEqual(orders.cancelled.createdAt);
			expect(cancelled.updatedAt).toEqual(orders.cancelled.updatedAt);

			const edited = await findOrderRaw(orders.edited._id);
			expect(edited.itemsRevision).toBe(1);
			expect(edited.itemsHistory).toHaveLength(1);
			expect(edited.itemsHistory[0].reason).toBe('Đổi sang huy hiệu');

			const combo = await findOrderRaw(orders.comboOrder._id);
			expect(combo.stockDeducted).toBe(true);
			expect(combo.internalNotes).toHaveLength(1);
			expect(combo.totalAmount).toBe(70000);
		});

		it('brings ids inside comboInfo and edit history back as native ids, not strings', async () => {
			const { orders } = await seedStore('a');
			const file = await exportFile(app, cookies);
			await emptyStore();

			expect((await restore(app, cookies, file)).status).toBe(200);

			const combo = await findOrderRaw(orders.comboOrder._id);
			expect(isRowId(combo.comboInfo.combos[0].comboId)).toBe(true);
			expect(isRowId(combo.items[0].productId)).toBe(true);
			expect(isRowId(combo.items[0].comboId)).toBe(true);
			const edited = await findOrderRaw(orders.edited._id);
			expect(isRowId(edited.itemsHistory[0].previousItems[0].productId)).toBe(true);
			expect(isRowId(edited.itemsHistory[0].previousItems[0]._id)).toBe(true);
		});

		it('restores the stock ledger as it was: applied rows stay applied, pending rows stay pending', async () => {
			const { products } = await seedStore('a');
			const file = await exportFile(app, cookies);
			const before = await movements();
			await emptyStore();

			expect((await restore(app, cookies, file)).status).toBe(200);

			const after = await movements();
			expect(after).toEqual(before);
			expect(after.filter((m) => m.status === 'pending').map((m) => m.type).sort()).toEqual(['adjust', 'set_target']);
			expect(after.find((m) => m.type === 'order_cancel')).toEqual(expect.objectContaining({ status: 'applied', stockAfter: expect.any(Number) }));
			expect((await findProduct(products.lanyard._id)).stockQuantity).toBe(9);
		});
	});

	describe('replaces what is there', () => {
		it('leaves only the file\'s data: other products, orders, movements and settings are gone', async () => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			const expectedRows = await readStore();
			await emptyStore();
			const other = await seedStore('b');
			expect(await countRows('product')).toBe(3);

			const res = await restore(app, cookies, file);

			expect(res.status).toBe(200);
			expect(await readStore()).toEqual(expectedRows);
			expect(await findProduct(other.products.lanyard._id)).toBeNull();
			expect(await countRows('order', { orderCode: other.orders.comboOrder.orderCode })).toBe(0);
			expect((await findSettings()).storeTitle).toBe('SAB Store a');
		});
	});

	describe('all or nothing', () => {
		it('rolls everything back when a write fails after the old rows were deleted', async () => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			await emptyStore();
			await seedStore('b');
			const before = await readStore();
			const fault = failNextOrderBulkInsert('disk full');

			const res = await restore(app, cookies, file);

			expect(fault.fired()).toBe(true);
			expect(res.status).toBe(500);
			expect(res.body.code).toBe('RESTORE_ERROR');
			expect(await readStore()).toEqual(before);
		});

		it('refuses a file whose stock cache disagrees with its ledger, and changes nothing', async () => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			await emptyStore();
			await seedStore('b');
			const before = await readStore();
			file.data.products[0].stockQuantity += 5;

			const res = await restore(app, cookies, file);

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('RESTORE_STOCK_MISMATCH');
			expect(res.body.problems).toHaveLength(1);
			expect(res.body.problems[0]).toContain(file.data.products[0].name);
			expect(await readStore()).toEqual(before);
		});

		it('hands no movement to the queue when the restore is refused', async () => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			file.data.products[0].stockQuantity += 1;
			const enqueue = vi.spyOn(stockQueue, 'enqueueMovementJobs').mockResolvedValue();

			const res = await restore(app, cookies, file);

			expect(res.status).toBe(400);
			expect(enqueue).not.toHaveBeenCalled();
		});

		it.each([
			['a total that does not match the lines', (file) => { file.data.orders[0].totalAmount += 1; }, 'tổng tiền'],
			['a fractional price', (file) => { file.data.products[0].price = 10.5; }, 'products[0].price'],
			['a negative price', (file) => { file.data.combos[0].price = -1; }, 'combos[0].price'],
			['a malformed id', (file) => { file.data.products[0]._id = 'not-an-id'; }, 'products[0]._id'],
			['an unknown order status', (file) => { file.data.orders[0].status = 'teleported'; }, 'orders[0].status'],
			['an unknown field', (file) => { file.data.products[0].isAdmin = true; }, 'isAdmin'],
			['a duplicate idempotency key', (file) => { file.data.stockMovements[1].idempotencyKey = file.data.stockMovements[0].idempotencyKey; }, 'idempotencyKey'],
			['a count that does not match the metadata', (file) => { file.metadata.collections.orders += 1; }, 'metadata.collections.orders'],
			['a missing section', (file) => { delete file.data.settings; }, 'settings']
		])('rejects %s before touching the data', async (_label, damage, expectedProblem) => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			await emptyStore();
			await seedStore('b');
			const before = await readStore();
			damage(file);

			const res = await restore(app, cookies, file);

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('RESTORE_FILE_INVALID');
			expect(res.body.problems.join('\n')).toContain(expectedProblem);
			expect(await readStore()).toEqual(before);
		});

		const nested = (depth) => (depth === 0 ? { leaf: true } : { inner: nested(depth - 1) });

		it.each([
			['a comboInfo nested too deep', (info) => ({ ...info, extra: nested(12) }), 'lồng quá sâu'],
			['an operator key in comboInfo', (info) => ({ ...info, extra: { $where: 'true' } }), '"$where"'],
			['a dotted key in comboInfo', (info) => ({ ...info, 'a.b': 1 }), '"a.b"']
		])('rejects %s with a clear problem line and changes nothing', async (_label, damage, expectedProblem) => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			await emptyStore();
			await seedStore('b');
			const before = await readStore();
			const comboOrder = file.data.orders.find((order) => order.comboInfo);
			comboOrder.comboInfo = damage(comboOrder.comboInfo);

			const res = await restore(app, cookies, file);

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('RESTORE_FILE_INVALID');
			expect(res.body.problems.join('\n')).toContain(expectedProblem);
			expect(res.body.problems.join('\n')).toContain('.comboInfo');
			expect(await readStore()).toEqual(before);
		});

		it('reports a unique-key clash the file does not show on its face, and changes nothing', async () => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			await emptyStore();
			await seedStore('b');
			const before = await readStore();
			file.data.orders[1].orderCode = file.data.orders[0].orderCode;

			const res = await restore(app, cookies, file);

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('RESTORE_FILE_INVALID');
			expect(res.body.problems[0]).toContain('orderCode');
			expect(await readStore()).toEqual(before);
		});
	});

	describe('confirmation and file kind', () => {
		it.each([
			['missing', null],
			['wrong', 'khoi phuc'],
			['padded', ' KHOI PHUC ']
		])('answers 400 and changes nothing when the phrase is %s', async (_label, phrase) => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			const before = await readStore();

			const res = await restore(app, cookies, file, phrase);

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('RESTORE_CONFIRMATION_REQUIRED');
			expect(await readStore()).toEqual(before);
		});

		it('answers 400 when no file is attached', async () => {
			const res = await restore(app, cookies, undefined);
			expect(res.status).toBe(400);
			expect(res.body.code).toBe('NO_FILE');
		});

		it('sends a v1 file to Import, in Vietnamese, and changes nothing', async () => {
			await seedStore('a');
			const before = await readStore();
			const v1 = { metadata: { version: '2.0', collections: { products: 0 } }, data: { products: [], combos: [], orders: [] } };

			const res = await restore(app, cookies, v1);

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('RESTORE_FORMAT_UNSUPPORTED');
			expect(res.body.message).toContain('Nhập Database');
			expect(await readStore()).toEqual(before);
		});

		it('rejects a non-JSON upload with the upload error, not a 500', async () => {
			const res = await request(app)
				.post('/api/admin/database/restore')
				.set('Cookie', cookies)
				.field('confirmation', PHRASE)
				.attach('dataFile', Buffer.from('x'), { filename: 'backup.txt', contentType: 'text/plain' });
			expect(res.status).toBe(400);
			expect(res.body.code).toBe('INVALID_FILE_TYPE');
		});

		it('rejects invalid JSON', async () => {
			const res = await request(app)
				.post('/api/admin/database/restore')
				.set('Cookie', cookies)
				.field('confirmation', PHRASE)
				.attach('dataFile', Buffer.from('{nope'), { filename: 'backup.json', contentType: 'application/json' });
			expect(res.status).toBe(400);
			expect(res.body.code).toBe('RESTORE_FILE_INVALID');
		});
	});

	describe('access', () => {
		it('answers 401 or 403 with no session and changes nothing', async () => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			const before = await readStore();

			const res = await request(app)
				.post('/api/admin/database/restore')
				.field('confirmation', PHRASE)
				.attach('dataFile', Buffer.from(JSON.stringify(file)), { filename: 'backup.json', contentType: 'application/json' });

			expect([401, 403]).toContain(res.status);
			expect(await readStore()).toEqual(before);
		});

		it('refuses a seller', async () => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			const before = await readStore();
			const seller = await makeSellerSession(app);

			const res = await restore(app, seller.cookies, file);

			expect([401, 403]).toContain(res.status);
			expect(await readStore()).toEqual(before);
		});
	});

	describe('credentials', () => {
		it('refuses a file carrying a login section and creates no login row', async () => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			const before = await readStore();
			const counts = { user: await countRows('user'), account: await countRows('account'), session: await countAuthRows('session'), jwks: await countAuthRows('jwks') };
			file.data.users = [{ email: 'evil@test.local' }];
			file.data.accounts = [{ password: 'forged' }];
			file.data.sessions = [{ token: 'forged' }];
			file.data.jwks = [{ privateKey: 'forged' }];

			const res = await restore(app, cookies, file);

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('RESTORE_FILE_INVALID');
			for (const section of ['users', 'accounts', 'sessions', 'jwks']) {
				expect(res.body.problems.join('\n')).toContain(`"${section}"`);
			}
			expect(await readStore()).toEqual(before);
			expect({ user: await countRows('user'), account: await countRows('account'), session: await countAuthRows('session'), jwks: await countAuthRows('jwks') }).toEqual(counts);
		});
	});

	describe('credentials beside the data', () => {
		it('ignores login sections placed next to metadata and data and changes no login row', async () => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			await emptyStore();
			const counts = { user: await countRows('user'), account: await countRows('account'), session: await countAuthRows('session'), jwks: await countAuthRows('jwks') };
			const sneaky = {
				...file,
				users: [{ email: 'evil@test.local', role: 'admin' }],
				accounts: [{ password: 'forged' }],
				sessions: [{ token: 'forged' }],
				jwks: [{ privateKey: 'forged' }]
			};

			const res = await restore(app, cookies, sneaky);

			expect(res.status).toBe(200);
			expect(await countRows('product')).toBe(3);
			expect({ user: await countRows('user'), account: await countRows('account'), session: await countAuthRows('session'), jwks: await countAuthRows('jwks') }).toEqual(counts);
			expect(await countRows('user', { email: 'evil@test.local' })).toBe(0);
		});
	});

	describe('stock queue', () => {
		it('hands the pending movements to the queue only after the commit', async () => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			await emptyStore();
			let restoredProducts = null;
			let queued = null;
			vi.spyOn(stockQueue, 'enqueueMovementJobs').mockImplementation(async (ids) => {
				// Outside the transaction a row is only visible once it has committed.
				restoredProducts = await countRows('product');
				queued = ids;
			});

			const res = await restore(app, cookies, file);

			expect(res.status).toBe(200);
			expect(restoredProducts).toBe(3);
			const pending = file.data.stockMovements.filter((m) => m.status === 'pending').map((m) => m._id);
			expect(pending).toHaveLength(2);
			expect([...queued].sort()).toEqual([...pending].sort());
		});

		it('still restores when the queue is unreachable', async () => {
			await seedStore('a');
			const file = await exportFile(app, cookies);
			await emptyStore();
			vi.spyOn(stockQueue, 'enqueueMovementJobs').mockRejectedValue(new Error('redis down'));

			const res = await restore(app, cookies, file);

			expect(res.status).toBe(200);
			expect(await countRows('movement', { status: 'pending' })).toBe(2);
		});
	});

	it('restores an empty store file and leaves an empty store', async () => {
		const file = await exportFile(app, cookies);
		expect(file.metadata.collections).toEqual(EMPTY_STORE_COUNTS);
		await seedStore('a');

		const res = await restore(app, cookies, file);

		expect(res.status).toBe(200);
		expect(await countRows('product')).toBe(0);
		expect(await countRows('settings')).toBe(0);
	});

	it('refuses a stock cache that differs from the ledger even for a product without movements', async () => {
		const product = await makeProduct({ name: 'Lonely', stockQuantity: 0 });
		const file = await exportFile(app, cookies);
		file.data.products[0].stockQuantity = 4;

		const res = await restore(app, cookies, file);

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('RESTORE_STOCK_MISMATCH');
		expect((await findProduct(product._id)).stockQuantity).toBe(0);
	});
});

describe('GET /api/admin/database/export size', () => {
	it('refuses to produce a backup larger than a restore accepts', async () => {
		const app = buildTestApp();
		const { cookies } = await makeAdminSession(app);
		await seedStore('a');
		const original = databaseRoutes.limits.maxFileSize;
		databaseRoutes.limits.maxFileSize = 1000;
		try {
			const res = await request(app).get('/api/admin/database/export').set('Cookie', cookies);

			expect(res.status).toBe(413);
			expect(res.body.code).toBe('EXPORT_TOO_LARGE');
			expect(res.body.message).toContain('10MB');
			expect(res.headers['content-disposition']).toBeUndefined();
		} finally {
			databaseRoutes.limits.maxFileSize = original;
		}
	});
});

describe('GET /api/admin/database/export credentials', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	it('never puts a user, account, session or jwks value in the file', async () => {
		const admin = await makeAdminSession(app);
		await seedStore('a');
		// Asking for a token makes the auth library create its signing key.
		expect((await request(app).get('/api/auth/token').set('Cookie', admin.cookies)).status).toBe(200);
		// The values the login tables really hold, read back rather than guessed.
		const [user] = await findAuthRows('user');
		const [account] = await findAuthRows('account');
		const [session] = await findAuthRows('session');
		const [key] = await findAuthRows('jwks');
		const markers = [user.email, user.username, account.password, session.token, key.publicKey, key.privateKey];
		expect(markers.every((marker) => typeof marker === 'string' && marker.length > 6)).toBe(true);

		const res = await request(app).get('/api/admin/database/export').set('Cookie', admin.cookies);

		expect(res.status).toBe(200);
		for (const marker of markers) expect(res.text).not.toContain(marker);
		expect(Object.keys(res.body.data).sort()).toEqual([...SECTIONS].sort());
		expect(res.body.metadata.formatVersion).toBe(2);
	});
});
