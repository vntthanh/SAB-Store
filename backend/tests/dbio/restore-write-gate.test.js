/**
 * A restore replaces the whole store, so orders and stock writes must neither
 * run through it nor be lost with the data it replaces.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeProduct, makeOrder } = require('../helpers/factories');
const { expectedTotalFor } = require('../helpers/pricing');
const { countRows, failNextOrderBulkInsert, findOrder } = require('../helpers/db');
const { dataSnapshot } = require('../../data');
const writeGate = require('../../services/write-gate');
const { seedStore } = require('./snapshot-fixture');

const customer = { studentId: '24120001', fullName: 'Nguyen Van A', email: 'a@example.com', phoneNumber: '0987654321' };

const exportFile = async (app, cookies) => (await request(app).get('/api/admin/database/export').set('Cookie', cookies)).body;

const restore = (app, cookies, file) => request(app)
	.post('/api/admin/database/restore')
	.set('Cookie', cookies)
	.field('confirmation', 'KHOI PHUC')
	.attach('dataFile', Buffer.from(JSON.stringify(file)), { filename: 'backup.json', contentType: 'application/json' });

const placeOrder = async (app, product) => {
	const items = [{ productId: String(product._id), quantity: 1 }];
	return request(app).post('/api/orders').send({ ...customer, items, expectedTotal: await expectedTotalFor(items) });
};

/** Holds `replaceAll` open until `release()`, so the gate stays closed on demand. */
function holdRestore() {
	const original = dataSnapshot.replaceAll.bind(dataSnapshot);
	let release;
	let entered;
	const insideRestore = new Promise((resolve) => { entered = resolve; });
	const blocker = new Promise((resolve) => { release = resolve; });
	vi.spyOn(dataSnapshot, 'replaceAll').mockImplementation(async (...args) => {
		entered();
		await blocker;
		return original(...args);
	});
	return { insideRestore, release };
}

describe('write gate during a restore', () => {
	let app;
	let cookies;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		({ cookies } = await makeAdminSession(app));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		writeGate.open();
	});

	it('answers 503 to an order and to a status change while a restore runs, and writes nothing', async () => {
		const { products } = await seedStore('a');
		const file = await exportFile(app, cookies);
		const existing = await makeOrder({ orderCode: 'GATE01' });
		const ordersBefore = await countRows('order');
		const hold = holdRestore();

		const restoring = restore(app, cookies, file).then((res) => res);
		await hold.insideRestore;

		const created = await placeOrder(app, products.sticker);
		const changed = await request(app).put(`/api/admin/orders/${existing._id}`).set('Cookie', cookies).send({ status: 'paid' });
		const secondRestore = await restore(app, cookies, file);

		expect(created.status).toBe(503);
		expect(created.body.code).toBe('STORE_RESTORING');
		expect(created.body.message).toBe('Hệ thống đang khôi phục dữ liệu, vui lòng thử lại sau ít phút');
		expect(changed.status).toBe(503);
		expect(secondRestore.status).toBe(409);
		expect(secondRestore.body.code).toBe('RESTORE_IN_PROGRESS');
		expect(await countRows('order')).toBe(ordersBefore);
		expect((await findOrder(existing._id)).status).toBe('confirmed');

		hold.release();
		const done = await restoring;
		expect(done.status).toBe(200);

		const after = await placeOrder(app, products.sticker);
		expect(after.status).toBe(201);
	});

	it('reopens after a restore that failed', async () => {
		const { products } = await seedStore('a');
		const file = await exportFile(app, cookies);
		const fault = failNextOrderBulkInsert('disk full');

		const failed = await restore(app, cookies, file);

		expect(fault.fired()).toBe(true);
		expect(failed.status).toBe(500);
		const res = await placeOrder(app, products.sticker);
		expect(res.status).toBe(201);
	});

	it('reopens after a file that was refused before the gate closed', async () => {
		const { products } = await seedStore('a');
		const file = await exportFile(app, cookies);
		file.data.products[0].price = -1;

		expect((await restore(app, cookies, file)).status).toBe(400);

		expect((await placeOrder(app, products.sticker)).status).toBe(201);
	});

	it('catalogue reads stay available while a restore runs', async () => {
		await makeProduct({ name: 'Visible during restore' });
		const file = await exportFile(app, cookies);
		const hold = holdRestore();
		const restoring = restore(app, cookies, file).then((res) => res);
		await hold.insideRestore;

		const res = await request(app).get('/api/products');

		expect(res.status).toBe(200);
		hold.release();
		await restoring;
	});
});

describe('write gate', () => {
	afterEach(() => writeGate.open());

	/** Runs a gated handler that stays in flight until `finish()`. */
	function startWriter() {
		let finish;
		const hold = new Promise((resolve) => { finish = resolve; });
		const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
		const done = writeGate.gated(() => hold)({}, res, vi.fn());
		return { finish, done, res };
	}

	it('waits for a running writer before close() resolves', async () => {
		const writer = startWriter();
		let closed = false;
		const closing = writeGate.close({ timeoutMs: 2000 }).then(() => { closed = true; });

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(closed).toBe(false);
		const refused = startWriter();
		expect(refused.res.status).toHaveBeenCalledWith(503);

		writer.finish();
		await writer.done;
		await closing;
		expect(closed).toBe(true);
	});

	it('reopens and reports RESTORE_BUSY when writers do not drain in time', async () => {
		const writer = startWriter();

		await expect(writeGate.close({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'RESTORE_BUSY' });

		const accepted = startWriter();
		expect(accepted.res.status).not.toHaveBeenCalled();
		writer.finish();
		accepted.finish();
		await Promise.all([writer.done, accepted.done]);
	});

	it('refuses a second close() while the first holds the gate', async () => {
		await writeGate.close();

		await expect(writeGate.close()).rejects.toMatchObject({ code: 'RESTORE_IN_PROGRESS' });

		writeGate.open();
		await expect(writeGate.close()).resolves.toBeUndefined();
	});

	it('releases the slot when a gated handler throws', async () => {
		const next = vi.fn();
		const boom = new Error('boom');

		await writeGate.gated(async () => { throw boom; })({}, {}, next);

		expect(next).toHaveBeenCalledWith(boom);
		await expect(writeGate.close({ timeoutMs: 20 })).resolves.toBeUndefined();
	});
});
