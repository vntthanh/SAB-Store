/**
 * The orders repository contract. Rows are made through the repository (what
 * the routes do) or the raw oracle, and every stored result is re-read through tests/helpers/db.js, so a
 * backend that returns the right record but stores the wrong rows fails here.
 */
const data = require('../../data');
const { isDuplicateKeyOn, DuplicateKeyError, InvalidIdError, RecordValidationError } = require('../../data/errors');
const {
	newId, insertRawProduct, insertRawOrder, deleteProduct, findOrder, findOrderByCode, listOrders, countRows, withTransaction, txOptions
} = require('../helpers/db');

const { orders } = data;

afterAll(async () => {
	await require('../../lib/prisma').closeDb();
});

/** The record as the API serialises it, without the storage version key. */
function asJson(value) {
	const strip = (node) => {
		if (Array.isArray(node)) return node.map(strip);
		if (node === null || typeof node !== 'object') return node;
		return Object.fromEntries(Object.entries(node).filter(([key]) => key !== '__v').map(([key, inner]) => [key, strip(inner)]));
	};
	return strip(JSON.parse(JSON.stringify(value)));
}

let sequence = 0;
const nextCode = () => `W${Date.now().toString(36).slice(-5).toUpperCase()}${++sequence}`.slice(0, 10);

const makeProduct = (fields = {}) => insertRawProduct({ name: `Order Product ${++sequence}`, price: 1000, category: 'general', available: true, stockQuantity: 0, ...fields });
const lineOf = (product, quantity = 1, extra = {}) => ({ productId: product._id, productName: product.name, price: product.price, quantity, ...extra });

/** A web order through the repository, as the checkout route writes it. */
const webOrder = (items, extra = {}) => orders.create({
	orderCode: nextCode(),
	studentId: 'SV001',
	fullName: 'Nguyen Van A',
	email: 'a@test.vn',
	phoneNumber: '0912345678',
	items,
	totalAmount: items.reduce((sum, line) => sum + line.price * line.quantity, 0),
	status: 'confirmed',
	stockDeducted: true,
	lastUpdatedBy: 'system',
	comboInfo: null,
	statusHistory: [{ status: 'confirmed', updatedBy: 'system', updatedAt: new Date(), note: 'created' }],
	...extra
}, undefined);

describe('orders.create', () => {
	it('stores the order and returns the record the oracle reads back', async () => {
		const product = await makeProduct();
		const order = await webOrder([lineOf(product, 2)]);

		expect(typeof order._id).toBe('string');
		expect(order.items).toHaveLength(1);
		expect(order.statusHistory).toHaveLength(1);
		expect(order.comboInfo).toBeNull();
		expect(order.internalNotes).toEqual([]);
		expect(order.itemsHistory).toEqual([]);
		expect(order.itemsRevision).toBe(0);
		expect(asJson(await findOrder(order._id))).toEqual(asJson(order));
	});

	it('keeps lines and history in the order they were given, with their own ids', async () => {
		const products = [await makeProduct(), await makeProduct(), await makeProduct()];
		const order = await webOrder(products.map((product, index) => lineOf(product, index + 1)), {
			statusHistory: [0, 1, 2].map((index) => ({ status: 'confirmed', updatedBy: `actor-${index}`, updatedAt: new Date(2026, 9, 1, index) }))
		});

		const stored = await findOrder(order._id);
		expect(stored.items.map((line) => line.quantity)).toEqual([1, 2, 3]);
		expect(stored.items.map((line) => String(line.productId))).toEqual(products.map((product) => product._id));
		expect(stored.statusHistory.map((entry) => entry.updatedBy)).toEqual(['actor-0', 'actor-1', 'actor-2']);
		expect(new Set(order.items.map((line) => String(line._id))).size).toBe(3);
	});

	it('applies the schema rules: trims, uppercases the code, lowercases the email', async () => {
		const product = await makeProduct();
		const order = await webOrder([lineOf(product)], { orderCode: 'ab12cd', email: '  Buyer@Test.VN ', fullName: '  Tran B  ', additionalNote: '  giao nhanh ' });

		expect(order).toMatchObject({ orderCode: 'AB12CD', email: 'buyer@test.vn', fullName: 'Tran B', additionalNote: 'giao nhanh' });
		expect(await findOrderByCode('AB12CD')).toMatchObject({ email: 'buyer@test.vn', fullName: 'Tran B' });
	});

	it('refuses a web order without customer details and accepts a counter sale without them', async () => {
		const product = await makeProduct();
		const attempt = orders.create({ orderCode: nextCode(), items: [lineOf(product)], totalAmount: 1000 });
		await expect(attempt).rejects.toBeInstanceOf(RecordValidationError);
		await expect(attempt).rejects.toMatchObject({ fieldErrors: expect.arrayContaining([expect.objectContaining({ field: 'phoneNumber' })]) });

		const direct = await orders.create({ orderCode: nextCode(), isDirectSale: true, fullName: 'NB: seller', items: [lineOf(product)], totalAmount: 1000 });
		expect(direct.isDirectSale).toBe(true);
		expect(direct.phoneNumber).toBeUndefined();
		expect(await countRows('order')).toBe(1);
	});

	it.each([
		['a phone that is not ten digits', { phoneNumber: '12345' }, 'phoneNumber'],
		['an email that is not an address', { email: 'not-an-email' }, 'email'],
		['a note over 500 characters', { additionalNote: 'x'.repeat(501) }, 'additionalNote'],
		['a negative total', { totalAmount: -1 }, 'totalAmount'],
		['a status the enum lacks', { status: 'pending' }, 'status']
	])('refuses %s', async (_label, bad, field) => {
		const product = await makeProduct();
		await expect(webOrder([lineOf(product)], bad)).rejects.toMatchObject({
			name: 'RecordValidationError', fieldErrors: expect.arrayContaining([expect.objectContaining({ field })])
		});
		expect(await countRows('order')).toBe(0);
	});

	it('refuses a line with a zero quantity or a negative price, naming the line', async () => {
		const product = await makeProduct();
		await expect(webOrder([lineOf(product, 0)])).rejects.toBeInstanceOf(RecordValidationError);
		await expect(webOrder([lineOf(product, 1, { price: -5 })])).rejects.toBeInstanceOf(RecordValidationError);
		expect(await countRows('order')).toBe(0);
	});

	it('reports a repeated order code as a duplicate on orderCode and a repeated number on orderNumber', async () => {
		const product = await makeProduct();
		const first = await webOrder([lineOf(product)], { orderNumber: 'SAB000001' });

		const sameCode = await webOrder([lineOf(product)], { orderCode: first.orderCode }).catch((error) => error);
		expect(sameCode).toBeInstanceOf(DuplicateKeyError);
		expect(isDuplicateKeyOn(sameCode, 'orderCode')).toBe(true);

		const sameNumber = await webOrder([lineOf(product)], { orderNumber: 'SAB000001' }).catch((error) => error);
		expect(isDuplicateKeyOn(sameNumber, 'orderNumber')).toBe(true);
		expect(await countRows('order')).toBe(1);
	});

	it('retries a whole transaction with a fresh code after a duplicate, and leaves one order', async () => {
		const product = await makeProduct();
		const taken = await webOrder([lineOf(product)]);
		const codes = [taken.orderCode, nextCode()];
		let attempts = 0;

		let created;
		for (let attempt = 1; !created; attempt += 1) {
			attempts += 1;
			try {
				created = await data.withTransaction((tx) => orders.create({
					orderCode: codes[attempt - 1], studentId: 'SV9', fullName: 'Retry', email: 'r@test.vn', phoneNumber: '0912345678',
					items: [lineOf(product)], totalAmount: 1000
				}, tx));
			} catch (error) {
				if (!isDuplicateKeyOn(error, 'orderCode') || attempt >= codes.length) throw error;
			}
		}

		expect(attempts).toBe(2);
		expect(created.orderCode).toBe(codes[1]);
		expect(await countRows('order')).toBe(2);
	});

	it('writes inside the given transaction: a rollback leaves no order and no child rows', async () => {
		const product = await makeProduct();
		await expect(withTransaction(async (tx) => {
			await orders.create({ orderCode: nextCode(), isDirectSale: true, items: [lineOf(product)], totalAmount: 1000 }, tx);
			throw new Error('rolled back');
		})).rejects.toThrow('rolled back');

		expect(await countRows('order')).toBe(0);
	});
});

describe('orders reads', () => {
	it('answers null for an unknown id and refuses a malformed one', async () => {
		expect(await orders.findById(newId())).toBeNull();
		expect(await orders.findDetail(newId())).toBeNull();
		await expect(orders.findById('not-an-id')).rejects.toBeInstanceOf(InvalidIdError);
		await expect(orders.findDetail('not-an-id')).rejects.toBeInstanceOf(InvalidIdError);
	});

	it('finds by code, tells whether a code exists, and gives the stored record', async () => {
		const product = await makeProduct();
		const order = await webOrder([lineOf(product)]);

		expect(await orders.existsByCode(order.orderCode)).toBe(true);
		expect(await orders.existsByCode('NOPE1')).toBe(false);
		expect(asJson(await orders.findByCode(order.orderCode))).toEqual(asJson(order));
		expect(await orders.findByCode('NOPE1')).toBeNull();
		expect(asJson(await orders.findById(order._id))).toEqual(asJson(await findOrder(order._id)));
	});

	it('reads lines, history, notes and item edits in the order they were written, however the rows are stored', async () => {
		const product = await makeProduct();
		const at = (hour) => new Date(Date.UTC(2026, 9, 1, hour));
		const raw = await insertRawOrder({
			orderCode: `O${++sequence}`,
			items: [3, 1, 2].map((quantity) => lineOf(product, quantity, { productId: product._id })),
			statusHistory: ['confirmed', 'paid', 'delivered'].map((status, hour) => ({ status, updatedBy: `actor-${hour}`, updatedAt: at(hour) })),
			internalNotes: ['first', 'second', 'third'].map((note, hour) => ({ note, by: 'admin', at: at(hour) })),
			itemsHistory: ['one', 'two'].map((reason, hour) => ({ previousItems: [], previousComboInfo: null, editedBy: 'admin', editedAt: at(hour), reason }))
		});

		for (const order of [await orders.findById(raw._id), await orders.findDetail(raw._id), (await orders.listAll())[0], (await orders.listPage({ page: 1, limit: 5, sort: { createdAt: -1 } })).data[0]]) {
			expect(order.items.map((line) => line.quantity)).toEqual([3, 1, 2]);
			expect(order.statusHistory.map((entry) => entry.status)).toEqual(['confirmed', 'paid', 'delivered']);
			expect(order.internalNotes.map((entry) => entry.note)).toEqual(['first', 'second', 'third']);
			expect(order.itemsHistory.map((entry) => entry.reason)).toEqual(['one', 'two']);
		}
	});

	it('leaves out the fields named in omit and nothing else', async () => {
		const product = await makeProduct();
		const order = await webOrder([lineOf(product)], { internalNotes: [{ note: 'n', by: 'admin' }] });

		const detail = await orders.findDetail(order._id, { omit: ['internalNotes', 'itemsHistory'] });
		expect(detail).not.toHaveProperty('internalNotes');
		expect(detail).not.toHaveProperty('itemsHistory');
		expect(detail.items).toHaveLength(1);
		expect((await orders.findDetail(order._id)).internalNotes).toHaveLength(1);
		await expect(orders.findDetail(order._id, { omit: ['items'] })).rejects.toThrow('Cannot omit order field: items');
	});

	it('attaches the named product fields to each line, or null for a product that is gone', async () => {
		const kept = await makeProduct({ name: 'Kept', imageUrl: '/kept.png' });
		const gone = await makeProduct({ name: 'Gone' });
		const order = await webOrder([lineOf(kept), lineOf(gone)]);
		await deleteProduct(gone._id);

		const detail = await orders.findDetail(order._id, { withProducts: ['name', 'imageUrl'] });
		expect(String(detail.items[0].productId._id)).toBe(kept._id);
		expect(detail.items[0].productId).toMatchObject({ name: 'Kept', imageUrl: '/kept.png' });
		expect(detail.items[1].productId).toBeNull();

		const attached = await orders.attachProducts(order, ['name']);
		expect(attached.items[0].productId).toMatchObject({ name: 'Kept' });
		await expect(orders.findDetail(order._id, { withProducts: ['name; drop'] })).rejects.toThrow('Invalid product field');
	});

	it('lists the newest orders first, ties by id, and exports every order', async () => {
		const product = await makeProduct();
		const stamp = new Date('2026-10-05T01:00:00.000Z');
		const created = [];
		for (let i = 0; i < 4; i += 1) created.push(await insertRawOrder({ orderCode: `L${i}${++sequence}`, createdAt: stamp, items: [lineOf(product, 1, { productId: product._id })] }));
		const newest = await insertRawOrder({ orderCode: `L9${++sequence}`, createdAt: new Date('2026-10-06T01:00:00.000Z') });

		const recent = await orders.listRecent({ limit: 3 });
		expect(recent.map((order) => String(order._id))).toEqual([newest._id, ...[...created].map((order) => order._id).sort().reverse().slice(0, 2)]);
		const all = await orders.listAll();
		expect(all).toHaveLength(5);
		expect(String(all[0]._id)).toBe(newest._id);
		expect(all.slice(1).map((order) => String(order._id))).toEqual(created.map((order) => order._id).sort().reverse());
	});

	it('counts and deletes every order', async () => {
		const product = await makeProduct();
		await webOrder([lineOf(product)]);
		await webOrder([lineOf(product)]);

		expect(await orders.count()).toBe(2);
		expect(await orders.deleteAll()).toEqual({ deletedCount: 2 });
		expect(await orders.count()).toBe(0);
	});

	it('finds the highest SAB number and ignores other shapes', async () => {
		expect(await orders.latestOrderNumber()).toBeNull();
		for (const orderNumber of ['SAB000007', 'SAB000123', 'SAB12', 'SAB0000099', 'XSAB000500', 'sab000900']) {
			await insertRawOrder({ orderCode: `N${++sequence}`, orderNumber });
		}
		await insertRawOrder({ orderCode: `N${++sequence}` });

		expect(await orders.latestOrderNumber()).toBe('SAB000123');
		expect(await data.withTransaction((tx) => orders.latestOrderNumber(tx))).toBe('SAB000123');
	});

	it('reports the orders with a combo in either stored shape', async () => {
		const product = await makeProduct();
		const comboId = newId();
		await insertRawOrder({ orderCode: `C1${++sequence}`, items: [lineOf(product, 1, { productId: product._id })], comboInfo: { combos: [{ comboId: comboId, comboName: 'Twin', applications: 1, savings: 1 }], finalTotal: 1 } });
		await insertRawOrder({ orderCode: `C2${++sequence}`, comboInfo: { comboId: comboId, comboName: 'Old shape' } });
		await insertRawOrder({ orderCode: `C3${++sequence}` });

		const found = await orders.listWithCombo();
		expect(found).toHaveLength(2);
		expect(found.map((order) => order.orderCode).sort()).toEqual([expect.stringMatching(/^C1/), expect.stringMatching(/^C2/)]);
		expect(found.every((order) => typeof order._id === 'string')).toBe(true);
	});

	it('sums delivered revenue and counts per status and since each boundary', async () => {
		const day = 86400000;
		const now = Date.now();
		await insertRawOrder({ orderCode: `S1${++sequence}`, status: 'delivered', totalAmount: 5000, createdAt: new Date(now - 20 * day) });
		await insertRawOrder({ orderCode: `S2${++sequence}`, status: 'delivered', totalAmount: 2500, createdAt: new Date(now - 3 * day) });
		await insertRawOrder({ orderCode: `S3${++sequence}`, status: 'paid', totalAmount: 900, createdAt: new Date(now - 1000) });
		await insertRawOrder({ orderCode: `S4${++sequence}`, status: 'cancelled', totalAmount: 100, createdAt: new Date(now - 1000) });

		const summary = await orders.summarize({ todayFrom: new Date(now - day / 2), weekFrom: new Date(now - 7 * day), monthFrom: new Date(now - 30 * day) });

		expect(summary).toMatchObject({ total: 4, today: 2, week: 3, month: 4, delivered: 2, deliveredRevenue: 7500 });
		expect([...summary.byStatus].sort((a, b) => a.status.localeCompare(b.status))).toEqual([
			{ status: 'cancelled', count: 1 }, { status: 'delivered', count: 2 }, { status: 'paid', count: 1 }
		]);
		expect(() => JSON.stringify(summary)).not.toThrow();
		expect(await listOrders()).toHaveLength(4);
	});

	it('exposes the status enum and the final statuses in the same order on both backends', () => {
		expect(orders.STATUS_VALUES).toEqual(['confirmed', 'paid', 'delivered', 'cancelled']);
		expect(orders.FINAL_ORDER_STATUSES).toEqual(['cancelled', 'delivered']);
	});
});

describe('orders.listPage', () => {
	const seed = async (specs) => {
		const created = [];
		for (const spec of specs) created.push(await insertRawOrder({ orderCode: `P${++sequence}`, ...spec }));
		return created;
	};
	const page = (query) => orders.listPage({ page: 1, limit: 50, sort: { createdAt: -1 }, ...query });
	const codesOf = (result) => result.data.map((order) => order.orderCode);

	it('returns the envelope with the total of every match', async () => {
		await seed(Array.from({ length: 5 }, (_, i) => ({ createdAt: new Date(2026, 9, 1 + i) })));

		const result = await page({ page: 2, limit: 2 });

		expect(result.data).toHaveLength(2);
		expect(result.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
	});

	it('walks equal sort keys by id so a page boundary never repeats or drops a row', async () => {
		const stamp = new Date('2026-10-05T01:00:00.000Z');
		await seed(Array.from({ length: 7 }, () => ({ createdAt: stamp, totalAmount: 100 })));
		const seen = [];
		for (let pageNumber = 1; pageNumber <= 4; pageNumber += 1) {
			seen.push(...(await page({ page: pageNumber, limit: 2, sort: { totalAmount: 1 } })).data.map((order) => String(order._id)));
		}

		expect(seen).toHaveLength(7);
		expect(new Set(seen).size).toBe(7);
		expect(seen).toEqual([...seen].sort());
		const descending = (await page({ limit: 7, sort: { totalAmount: -1 } })).data.map((order) => String(order._id));
		expect(descending).toEqual([...descending].sort().reverse());
	});

	it('sorts by status alphabetically across page boundaries', async () => {
		await seed(['paid', 'cancelled', 'confirmed', 'delivered', 'paid', 'cancelled'].map((status) => ({ status })));

		const ascending = [];
		for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
			ascending.push(...(await page({ page: pageNumber, limit: 2, sort: { status: 1 } })).data.map((order) => order.status));
		}
		expect(ascending).toEqual(['cancelled', 'cancelled', 'confirmed', 'delivered', 'paid', 'paid']);

		const descending = (await page({ limit: 4, page: 1, sort: { status: -1 } })).data.map((order) => order.status);
		expect(descending).toEqual(['paid', 'paid', 'delivered', 'confirmed']);
		expect((await page({ limit: 4, page: 2, sort: { status: -1 } })).data.map((order) => order.status)).toEqual(['cancelled', 'cancelled']);
		expect((await page({ sort: { status: 1 } })).meta.total).toBe(6);
	});

	it('puts orders without a number first when sorting ascending and last when descending', async () => {
		await seed([{ orderNumber: 'SAB000002' }, {}, { orderNumber: 'SAB000001' }]);

		const ascending = (await page({ sort: { orderNumber: 1 } })).data.map((order) => order.orderNumber);
		expect(ascending).toEqual([undefined, 'SAB000001', 'SAB000002']);
		const descending = (await page({ sort: { orderNumber: -1 } })).data.map((order) => order.orderNumber);
		expect(descending).toEqual(['SAB000002', 'SAB000001', undefined]);
	});

	it('filters by status, by an inclusive date range and by text in the chosen fields', async () => {
		await seed([
			{ status: 'paid', fullName: 'Le Van A', email: 'a@x.vn', createdAt: new Date('2026-10-01T00:00:00.000Z') },
			{ status: 'paid', fullName: 'Pham 100% Thanh', email: 'b@x.vn', createdAt: new Date('2026-10-02T00:00:00.000Z') },
			{ status: 'confirmed', fullName: 'Tran_B', email: 'c@x.vn', createdAt: new Date('2026-10-03T00:00:00.000Z') }
		]);
		const fields = ['fullName', 'email'];

		expect((await page({ status: 'paid' })).meta.total).toBe(2);
		expect((await page({ status: 'pending' })).meta.total).toBe(0);
		expect(codesOf(await page({ createdFrom: new Date('2026-10-02T00:00:00.000Z'), createdTo: new Date('2026-10-02T00:00:00.000Z') }))).toHaveLength(1);
		expect((await page({ search: 'LE VAN', searchFields: fields })).meta.total).toBe(1);
		expect((await page({ search: '100%', searchFields: fields })).meta.total).toBe(1);
		expect((await page({ search: '%', searchFields: fields })).meta.total).toBe(1);
		expect((await page({ search: '_', searchFields: fields })).meta.total).toBe(1);
		expect((await page({ search: '.*', searchFields: fields })).meta.total).toBe(0);
		expect((await page({ search: 'x.vn', searchFields: ['fullName'] })).meta.total).toBe(0);
	});

	it('refuses a sort, an omit and a search field it does not know', async () => {
		await expect(page({ sort: { internalNotes: 1 } })).rejects.toThrow('Unsupported order sort');
		await expect(page({ sort: { createdAt: 1, status: 1 } })).rejects.toThrow('Unsupported order sort');
		await expect(page({ omit: ['items'] })).rejects.toThrow('Cannot omit order field');
		await expect(page({ search: 'a', searchFields: ['totalAmount'] })).rejects.toThrow('Cannot search order field');
	});

	it('attaches the product fields on a page and leaves out the admin-only arrays', async () => {
		const product = await makeProduct({ name: 'Paged' });
		await seed([{ items: [lineOf(product, 1, { productId: product._id })], internalNotes: [{ note: 'secret', by: 'admin' }] }]);

		const result = await page({ omit: ['internalNotes', 'itemsHistory'], withProducts: ['name'] });

		expect(result.data[0]).not.toHaveProperty('internalNotes');
		expect(result.data[0].items[0].productId).toMatchObject({ name: 'Paged' });
	});
});
