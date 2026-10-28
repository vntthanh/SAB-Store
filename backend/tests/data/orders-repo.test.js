/**
 * Contract of the orders repository: what a caller may rely on whatever store
 * sits underneath. Rows are seeded through the factories, never through the
 * repository under test.
 */
const { orders, withTransaction } = require('../../data');
const { DuplicateKeyError, InvalidIdError, RecordValidationError, isDuplicateKeyOn } = require('../../data/errors');
const { makeProduct, makeOrder } = require('../helpers/factories');
const { findProduct, deleteProduct } = require('../helpers/db');

const lineOf = (product, quantity = 1) => ({ productId: product._id, productName: product.name, price: product.price, quantity });

describe('orders repository: attaching products', () => {
	it('turns each productId into { _id, ...fields } and a vanished product into null', async () => {
		const kept = await makeProduct({ name: 'Kept', price: 1000, imageUrl: '/k.png', category: 'pins' });
		const gone = await makeProduct({ name: 'Gone', price: 2000 });
		const order = await makeOrder({ items: [lineOf(gone), lineOf(kept)], totalAmount: 3000 });
		await deleteProduct(gone._id);

		const found = await orders.findDetail(order._id, { withProducts: ['name', 'imageUrl'] });

		expect(found.items[0].productId).toBeNull();
		expect(found.items[1].productId).toEqual({ _id: String(kept._id), name: 'Kept', imageUrl: '/k.png' });
		expect(typeof found._id).toBe('string');
	});

	it('attaches to a record from a status change, which carries only product ids', async () => {
		const product = await makeProduct({ name: 'Cap', price: 500 });
		const order = await makeOrder({ items: [lineOf(product)], totalAmount: 500 });

		const changed = await withTransaction((tx) => orders.applyStatusChange({
			orderId: String(order._id),
			fromStatus: 'confirmed',
			fields: { status: 'paid' },
			historyEntry: { status: 'paid', updatedBy: 'tester', updatedAt: new Date() }
		}, tx));
		const attached = await orders.attachProducts(changed, ['name']);

		expect(typeof changed._id).toBe('string');
		expect(changed.status).toBe('paid');
		expect(attached.items[0].productId).toEqual({ _id: String(product._id), name: 'Cap' });
		expect(attached.statusHistory.at(-1).status).toBe('paid');
	});

	it('refuses a field name that is not a plain field', async () => {
		const order = await makeOrder();
		await expect(orders.findDetail(order._id, { withProducts: ['-name'] })).rejects.toThrow(TypeError);
	});
});

describe('orders repository: reads', () => {
	it('omits only the named fields and refuses others', async () => {
		const order = await makeOrder();

		const found = await orders.findDetail(order._id, { omit: ['internalNotes', 'itemsHistory'] });

		expect(found).not.toHaveProperty('internalNotes');
		expect(found).not.toHaveProperty('itemsHistory');
		expect(found.orderCode).toBe(order.orderCode);
		await expect(orders.findDetail(order._id, { omit: ['totalAmount'] })).rejects.toThrow(TypeError);
	});

	it('answers null for an unknown id and InvalidIdError for a malformed one', async () => {
		expect(await orders.findDetail('507f1f77bcf86cd799439011')).toBeNull();
		await expect(orders.findDetail('zzz')).rejects.toBeInstanceOf(InvalidIdError);
		await expect(orders.updateNotes({ orderId: 'zzz', additionalNote: 'x' })).rejects.toBeInstanceOf(InvalidIdError);
	});

	it('lists one sort entry from the allowed set and nothing else', async () => {
		const page = { page: 1, limit: 5 };
		await expect(orders.listPage({ ...page, sort: { internalNotes: 1 } })).rejects.toThrow(TypeError);
		await expect(orders.listPage({ ...page, sort: { createdAt: 1, status: 1 } })).rejects.toThrow(TypeError);
		await expect(orders.listPage({ ...page, sort: { createdAt: 'asc' } })).rejects.toThrow(TypeError);
		await expect(orders.listPage({ ...page, sort: { createdAt: -1 }, searchFields: ['internalNotes'] })).rejects.toThrow(TypeError);
		await expect(orders.listPage({ ...page, sort: { createdAt: -1 }, status: { $ne: 'paid' } })).rejects.toThrow(TypeError);
	});

	it('treats a search containing regex syntax as plain text', async () => {
		await makeOrder({ fullName: 'Plain Name' });

		const { data, meta } = await orders.listPage({
			page: 1, limit: 5, sort: { createdAt: -1 }, search: '.*', searchFields: ['fullName']
		});

		expect(data).toEqual([]);
		expect(meta.total).toBe(0);
	});

	it('summarizes counts, delivered revenue and statuses', async () => {
		await makeOrder({ totalAmount: 100, items: [], status: 'delivered' });
		await makeOrder({ totalAmount: 50, items: [], status: 'delivered' });
		await makeOrder({ totalAmount: 7, items: [], status: 'paid' });
		const past = new Date(Date.now() - 86400000 * 400);

		const summary = await orders.summarize({ todayFrom: past, weekFrom: past, monthFrom: new Date(Date.now() + 86400000) });

		expect(summary).toMatchObject({ total: 3, today: 3, week: 3, month: 0, delivered: 2, deliveredRevenue: 150 });
		expect(summary.byStatus).toEqual(expect.arrayContaining([{ status: 'delivered', count: 2 }, { status: 'paid', count: 1 }]));
	});

	it('finds the highest SAB number and ignores other shapes', async () => {
		expect(await withTransaction((tx) => orders.latestOrderNumber(tx))).toBeNull();
		await makeOrder({ orderNumber: 'SAB000002' });
		await makeOrder({ orderNumber: 'SAB000010' });
		await makeOrder({ orderNumber: 'SAB1234567' });

		expect(await withTransaction((tx) => orders.latestOrderNumber(tx))).toBe('SAB000010');
	});
});

describe('orders repository: writes', () => {
	it('reports a repeated order code as DuplicateKeyError on that column and a bad field as RecordValidationError', async () => {
		const existing = await makeOrder();
		const fields = {
			orderCode: existing.orderCode, studentId: 'S', fullName: 'F', email: 'f@example.com', phoneNumber: '0912345678',
			items: [], totalAmount: 0
		};

		const duplicate = await withTransaction((tx) => orders.create(fields, tx)).catch((e) => e);
		const invalid = await withTransaction((tx) => orders.create({ ...fields, orderCode: 'NEW01', phoneNumber: '123' }, tx)).catch((e) => e);

		expect(duplicate).toBeInstanceOf(DuplicateKeyError);
		expect(duplicate.fields).toEqual(['orderCode']);
		expect(isDuplicateKeyOn(duplicate, 'orderCode')).toBe(true);
		expect(invalid).toBeInstanceOf(RecordValidationError);
		expect(invalid.fieldErrors.map((entry) => entry.field)).toContain('phoneNumber');
	});

	it('appends an internal note and edits the customer note in one update', async () => {
		const order = await makeOrder();
		const at = new Date();

		const updated = await orders.updateNotes({ orderId: String(order._id), additionalNote: 'hi', internalNote: { note: 'n', by: 'admin', at } });

		expect(updated).toMatchObject({ additionalNote: 'hi', internalNotes: [{ note: 'n', by: 'admin' }] });
		expect(await orders.updateNotes({ orderId: '507f1f77bcf86cd799439011', additionalNote: 'x' })).toBeNull();
	});

	it('counts and deletes every order', async () => {
		await makeOrder();
		await makeOrder();

		expect(await orders.count()).toBe(2);
		expect(await orders.deleteAll()).toEqual({ deletedCount: 2 });
		expect(await orders.count()).toBe(0);
	});

	it('leaves the stock of a product alone', async () => {
		const product = await makeProduct({ stockQuantity: 5 });
		await makeOrder({ items: [lineOf(product)], totalAmount: product.price });
		await orders.deleteAll();

		expect((await findProduct(product._id)).stockQuantity).toBe(5);
	});
});

describe('isDuplicateKeyOn', () => {
	it('matches only a unique-key violation that names one of the columns', () => {
		expect(isDuplicateKeyOn(new DuplicateKeyError(['orderCode']), 'orderCode')).toBe(true);
		expect(isDuplicateKeyOn(new DuplicateKeyError(['orderNumber']), 'orderCode', 'orderNumber')).toBe(true);
		expect(isDuplicateKeyOn(new DuplicateKeyError(['idempotencyKey']), 'orderCode', 'orderNumber')).toBe(false);
		expect(isDuplicateKeyOn(new DuplicateKeyError([]), 'orderCode')).toBe(false);
		expect(isDuplicateKeyOn(new Error('boom'), 'orderCode')).toBe(false);
		expect(isDuplicateKeyOn(null, 'orderCode')).toBe(false);
	});
});

describe('orders repository: listAll and existsByCode', () => {
	const sale = (fields) => makeOrder({ items: [], totalAmount: 0, ...fields });

	it('returns every match newest first, past any page size, filtered like a page', async () => {
		const base = Date.now() - 60 * 86400000;
		for (let i = 0; i < 25; i += 1) {
			await sale({ orderCode: `LA${String(i).padStart(2, '0')}`, createdAt: new Date(base + i * 3600000), status: i % 5 === 0 ? 'paid' : 'confirmed' });
		}

		const all = await orders.listAll();
		const paid = await orders.listAll({ status: 'paid' });
		const ranged = await orders.listAll({ createdFrom: new Date(base + 10 * 3600000), createdTo: new Date(base + 12 * 3600000) });
		const searched = await orders.listAll({ search: 'la1', searchFields: ['orderCode'] });

		expect(all).toHaveLength(25);
		expect(all.map((order) => order.orderCode)).toEqual([...all.map((order) => order.orderCode)].sort().reverse());
		expect(typeof all[0]._id).toBe('string');
		expect(paid.map((order) => order.orderCode).sort()).toEqual(['LA00', 'LA05', 'LA10', 'LA15', 'LA20']);
		expect(ranged.map((order) => order.orderCode)).toEqual(['LA12', 'LA11', 'LA10']);
		expect(searched).toHaveLength(10);
	});

	it('takes the search text literally and refuses a field it does not know', async () => {
		await sale({ orderCode: 'LB.1' });
		await sale({ orderCode: 'LBX1' });

		expect(await orders.listAll({ search: 'LB.1', searchFields: ['orderCode'] })).toHaveLength(1);
		await expect(orders.listAll({ search: 'x', searchFields: ['internalNotes'] })).rejects.toThrow(TypeError);
	});

	it('says whether an order code is taken', async () => {
		await sale({ orderCode: 'EX001' });

		expect(await orders.existsByCode('EX001')).toBe(true);
		expect(await orders.existsByCode('EX002')).toBe(false);
	});
});
