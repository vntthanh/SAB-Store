/**
 * The backup contract (export, restore, row counts) on whichever backend
 * DATA_BACKEND selects. The store under test is built through the repositories
 * and services, so its ledger is consistent as in a live store; every result is
 * read back through tests/helpers/db.js.
 */
const mongoose = require('mongoose');
const { objectIdToUuidV7 } = require('@sab/shared');
const data = require('../../data');
const { validateSnapshot, buildMetadata } = require('../../data/snapshot');
const { isDuplicateKeyError } = require('../../data/errors');
const { recordMovement, recordAppliedOpening, applyMovement, reconcile } = require('../../services/stock-ledger');
const { recordOrderMovements } = require('../../services/stock');
const { generatePublicCode } = require('../../utils/public-code');
const {
	newId, insertRawProduct, insertRawOrder, findProduct, findOrder, findCombo, movements, stockOf, countRows, deleteAllRows,
	listProducts, listOrders, withTransaction, txOptions, failNextOrderBulkInsert, findSettings, listCombos, patchMovement
} = require('../helpers/db');

const { dataSnapshot, orders } = data;
const POSTGRES = process.env.DATA_BACKEND === 'postgres';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECTIONS = ['products', 'combos', 'orders', 'stockMovements', 'settings'];

afterAll(async () => {
	if (POSTGRES) await require('../../lib/prisma').closeDb();
});

const ref = (id) => (POSTGRES ? id : new mongoose.Types.ObjectId(id));

/** The id a legacy hex id has on this backend. */
const mapped = (hex) => (POSTGRES ? objectIdToUuidV7(hex) : hex);

const fileOf = (snapshot) => ({ metadata: buildMetadata(snapshot, new Date()), data: snapshot });

const restore = (snapshot) => data.withTransaction(async (tx) => {
	const written = await dataSnapshot.replaceAll(snapshot, tx);
	const mismatches = await reconcile({ tx });
	if (mismatches.length > 0) throw Object.assign(new Error('stock mismatch'), { mismatches });
	return written;
});

/** Applies the pending movements of a product oldest first, as the worker would, and returns how many were applied. */
async function applyPendingOf(productId) {
	let applied = 0;
	for (const movement of await movements({ status: 'pending', productId })) {
		if ((await applyMovement(movement._id)).applied) applied += 1;
	}
	return applied;
}

/** A store with every shape a backup has to bring back. */
async function seedStore() {
	const makeProduct = (fields, opening) => data.withTransaction(async (tx) => {
		const product = await data.products.create(fields, opening, tx);
		await recordAppliedOpening({ productId: product._id, quantity: opening, createdBy: 'seed', reason: 'seed' }, txOptions(tx));
		return product;
	});
	const lanyard = await makeProduct({
		name: 'Lanyard', category: 'lanyard', price: 40000, tags: ['pin', 'new'], salePrice: 30000, weight: 1.5,
		saleStartDate: new Date('2026-10-01T00:00:00.000Z'), dimensions: { length: 1, width: 2, height: 3 }
	}, 10);
	const badge = await makeProduct({ name: 'Badge', category: 'badge', price: 25000 }, 5);
	const sticker = await makeProduct({ name: 'Sticker', category: 'sticker', price: 5000, salesChannel: 'online' }, 4);

	const combo = await data.combos.create({
		name: 'Twin', price: 60000, categoryRequirements: [{ category: 'lanyard', quantity: 1 }, { category: 'badge', quantity: 1 }]
	});

	const line = (product, quantity, extra = {}) => ({ productId: product._id, productName: product.name, price: product.price, quantity, ...extra });
	const comboOrder = await orders.create({
		orderCode: 'C0001', studentId: 'SV1', fullName: 'Nguyen A', email: 'a@test.vn', phoneNumber: '0912345678', additionalNote: 'Giao tại cơ sở 1',
		items: [line(lanyard, 1, { fromCombo: true, comboId: combo._id, comboName: combo.name }), line(badge, 1, { fromCombo: true, comboId: combo._id, comboName: combo.name })],
		totalAmount: 60000, status: 'confirmed', stockDeducted: true,
		comboInfo: { savings: 5000, originalTotal: 65000, finalTotal: 60000, combos: [{ comboId: combo._id, comboName: combo.name, applications: 1, savings: 5000 }] },
		statusHistory: [{ status: 'confirmed', updatedBy: 'system', updatedAt: new Date('2026-10-01T01:00:00.000Z') }]
	});
	await orders.updateNotes({ orderId: comboOrder._id, internalNote: { note: 'Khách hẹn thứ Sáu', by: 'admin', at: new Date('2026-10-02T03:04:05.000Z') } });
	await orders.create({
		orderCode: 'D0002', isDirectSale: true, fullName: 'NB: seller', createdBy: newId(), orderNumber: 'SAB000001',
		items: [line(sticker, 3)], totalAmount: 15000, status: 'paid', stockDeducted: true, lastUpdatedBy: 'seller-1'
	});
	await orders.create({
		orderCode: 'X0003', studentId: 'SV2', fullName: 'Tran B', email: 'b@test.vn', phoneNumber: '0987654321',
		items: [line(lanyard, 3)], totalAmount: 120000, status: 'cancelled', cancelReason: 'Khách đổi ý', stockDeducted: false,
		statusHistory: [
			{ status: 'confirmed', updatedBy: 'system', updatedAt: new Date('2026-10-01T01:00:00.000Z') },
			{ status: 'cancelled', updatedBy: 'admin', updatedAt: new Date('2026-10-01T02:00:00.000Z'), note: 'gọi không được', cancelReason: 'Khách đổi ý' }
		]
	});
	await orders.create({
		orderCode: 'E0004', studentId: 'SV3', fullName: 'Le C', email: 'c@test.vn', phoneNumber: '0911111111',
		items: [line(badge, 2)], totalAmount: 50000, status: 'paid', stockDeducted: true, itemsRevision: 1,
		itemsHistory: [{ previousItems: [line(lanyard, 1, { comboId: null })], previousComboInfo: null, editedBy: 'admin', editedAt: new Date('2026-10-03T00:00:00.000Z'), reason: 'đổi màu' }]
	});

	// Ledger: applied, pending, and a pending set_target whose delta is not known yet.
	const adjust = await recordMovement({ productId: lanyard._id, type: 'adjust', delta: -2, idempotencyKey: 'seed:adjust', createdBy: 'admin', reason: 'mất' });
	await applyMovement(adjust._id);
	for (const movement of await recordOrderMovements({ orderId: comboOrder._id, items: comboOrder.items, type: 'order', keyTag: 'create', createdBy: 'system', reason: 'Đơn C0001' }, {})) {
		await applyMovement(movement._id);
	}
	await recordMovement({ productId: badge._id, type: 'adjust', delta: 3, idempotencyKey: 'seed:pending', createdBy: 'admin', reason: 'nhập' });
	await recordMovement({ productId: sticker._id, type: 'set_target', target: 7, idempotencyKey: 'seed:target', createdBy: 'admin', reason: 'kiểm kê' });

	await data.settings.upsertConfig({ bankNameId: '970436', bankAccountId: '123456789', prefixMessage: 'SAB', storeTitle: 'SAB Store', checkoutNotice: '', updatedBy: 'admin' });
	return { lanyard, badge, sticker, combo };
}

describe('dataSnapshot.exportAll', () => {
	it('returns every section as plain JSON that passes the file validation', async () => {
		await seedStore();

		const snapshot = await dataSnapshot.exportAll();

		expect(Object.keys(snapshot).sort()).toEqual([...SECTIONS].sort());
		expect(snapshot.products).toHaveLength(3);
		expect(snapshot.combos).toHaveLength(1);
		expect(snapshot.orders).toHaveLength(4);
		expect(snapshot.settings).toHaveLength(1);
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
		expect(validateSnapshot(fileOf(snapshot).metadata, snapshot)).toEqual([]);
	});

	it('keeps nested rows in order, absent fields absent and stored nulls where the file format has them', async () => {
		const { lanyard, combo } = await seedStore();

		const snapshot = await dataSnapshot.exportAll();

		const exportedCombo = snapshot.combos[0];
		expect(exportedCombo.categoryRequirements.map((requirement) => requirement.category)).toEqual(['lanyard', 'badge']);
		const order = snapshot.orders.find((entry) => entry.orderCode === 'C0001');
		expect(order.items.map((item) => item.productName)).toEqual(['Lanyard', 'Badge']);
		expect(String(order.items[0].comboId)).toBe(combo._id);
		expect(order.comboInfo.combos[0].comboId).toBe(combo._id);
		expect(order.internalNotes).toEqual([{ note: 'Khách hẹn thứ Sáu', by: 'admin', at: '2026-10-02T03:04:05.000Z' }]);
		const direct = snapshot.orders.find((entry) => entry.orderCode === 'D0002');
		expect(direct).not.toHaveProperty('phoneNumber');
		expect(direct.comboInfo).toBeNull();
		const product = snapshot.products.find((entry) => entry._id === lanyard._id);
		expect(product).toMatchObject({ tags: ['pin', 'new'], salePrice: 30000, saleStartDate: '2026-10-01T00:00:00.000Z', dimensions: { length: 1, width: 2, height: 3 } });
		expect(snapshot.products.find((entry) => entry.name === 'Badge')).not.toHaveProperty('salePrice');
		const target = snapshot.stockMovements.find((entry) => entry.idempotencyKey === 'seed:target');
		expect(target).toMatchObject({ type: 'set_target', target: 7, status: 'pending' });
		expect(target.delta == null).toBe(true);
	});

	it.skipIf(!POSTGRES)('lists movements in ledger order, with uuid ids and no sequence number', async () => {
		await seedStore();

		const snapshot = await dataSnapshot.exportAll();

		const keys = snapshot.stockMovements.map((movement) => movement.idempotencyKey);
		expect(keys.indexOf('seed:adjust')).toBeLessThan(keys.indexOf('seed:pending'));
		expect(keys.indexOf('seed:pending')).toBeLessThan(keys.indexOf('seed:target'));
		const ids = [...snapshot.products, ...snapshot.orders, ...snapshot.stockMovements].map((row) => row._id);
		expect(ids.every((id) => UUID.test(id))).toBe(true);
		expect(JSON.stringify(snapshot)).not.toMatch(/"seq"/);
	});

	it.skipIf(!POSTGRES)('lists movements by their place in the ledger, which is not always id order', async () => {
		await seedStore();
		const ledger = await movements();
		await patchMovement(ledger[0]._id, { seq: 1000000 });

		const snapshot = await dataSnapshot.exportAll();

		expect(snapshot.stockMovements.at(-1)._id).toBe(ledger[0]._id);
		await restore(snapshot);
		expect((await movements()).at(-1)._id).toBe(ledger[0]._id);
	});

	it.skipIf(!POSTGRES)('reads every section from one point in time: a movement applied mid-export cannot split the cache from the ledger', async () => {
		const { badge } = await seedStore();
		const pending = (await movements({ status: 'pending', productId: badge._id }))[0];
		const { prisma } = require('../../lib/prisma');
		const realTransaction = prisma.$transaction.bind(prisma);
		let applied = false;
		const interleaved = (tx) => new Proxy(tx, {
			get(target, property) {
				const value = Reflect.get(target, property);
				if (property !== 'product') return typeof value === 'function' ? value.bind(target) : value;
				return new Proxy(value, {
					get(delegate, method) {
						const original = Reflect.get(delegate, method);
						if (method !== 'findMany' || applied) return typeof original === 'function' ? original.bind(delegate) : original;
						// The products are read first; the ledger commits a change before the movements are.
						return async (...args) => {
							const rows = await original.apply(delegate, args);
							applied = true;
							expect((await applyMovement(pending._id)).applied).toBe(true);
							return rows;
						};
					}
				});
			}
		});
		const spy = vi.spyOn(prisma, '$transaction').mockImplementation((fn, ...rest) => (typeof fn === 'function' ? realTransaction((tx) => fn(interleaved(tx)), ...rest) : realTransaction(fn, ...rest)));

		const snapshot = await dataSnapshot.exportAll();
		spy.mockRestore();

		expect(applied).toBe(true);
		for (const product of snapshot.products) {
			const ledgerSum = snapshot.stockMovements.filter((movement) => movement.productId === product._id && movement.status === 'applied').reduce((sum, movement) => sum + movement.delta, 0);
			expect(product.stockQuantity, product.name).toBe(ledgerSum);
		}
	});

	it('counts rows per table, login tables included, as plain numbers', async () => {
		await seedStore();

		const counts = await dataSnapshot.countRows();

		expect(counts).toEqual({ users: 0, products: 3, orders: 4, accounts: 0, combos: 1 });
		expect(() => JSON.stringify(counts)).not.toThrow();
	});
});

describe('dataSnapshot.replaceAll', () => {
	it('replaces the store with the file: export, restore, export gives the same file', async () => {
		await seedStore();
		const first = await dataSnapshot.exportAll();

		// Things the file does not hold must be gone after the restore.
		await insertRawProduct({ name: 'Intruder', price: 1, category: 'x', available: true, stockQuantity: 0 });
		await insertRawOrder({ orderCode: 'ZZ9999', totalAmount: 0 });
		await deleteAllRows('combo');

		const written = await restore(first);

		expect(written).toEqual({ products: 3, combos: 1, orders: 4, stockMovements: first.stockMovements.length, settings: 1 });
		expect(await dataSnapshot.exportAll()).toEqual(first);
		expect(await countRows('product')).toBe(3);
		expect(await countRows('order')).toBe(4);
		expect(await countRows('combo')).toBe(1);
	});

	it('keeps every id, the stock caches, the ledger order and a working ledger afterwards', async () => {
		const { lanyard, badge } = await seedStore();
		const before = { stock: [await stockOf(lanyard._id), await stockOf(badge._id)], ledger: (await movements()).map((movement) => movement.idempotencyKey) };
		const snapshot = await dataSnapshot.exportAll();

		await restore(snapshot);

		expect([await stockOf(lanyard._id), await stockOf(badge._id)]).toEqual(before.stock);
		expect((await movements()).map((movement) => movement.idempotencyKey)).toEqual(before.ledger);
		const next = await recordMovement({ productId: badge._id, type: 'adjust', delta: 1, idempotencyKey: 'after-restore', createdBy: 'admin', reason: 'x' });
		expect(await applyPendingOf(badge._id)).toBe(2);
		expect((await movements()).at(-1).idempotencyKey).toBe('after-restore');
		expect(next.status).toBe('pending');
		expect(await stockOf(badge._id)).toBe(before.stock[1] + 3 + 1);
	});

	it('leaves the old data untouched when the restore fails halfway, and the ledger keeps working', async () => {
		const { badge } = await seedStore();
		const snapshot = await dataSnapshot.exportAll();
		const before = { products: await listProducts(), orders: (await listOrders()).length, ledger: (await movements()).length };

		const fault = failNextOrderBulkInsert('disk full');
		await expect(restore(snapshot)).rejects.toThrow('disk full');
		expect(fault.fired()).toBe(true);

		expect(await listProducts()).toEqual(before.products);
		expect((await listOrders()).length).toBe(before.orders);
		expect((await movements()).length).toBe(before.ledger);
		await recordMovement({ productId: badge._id, type: 'adjust', delta: 1, idempotencyKey: 'after-failed-restore', createdBy: 'admin', reason: 'x' });
		expect(await applyPendingOf(badge._id)).toBe(2);
	});

	it('refuses a file whose stock caches disagree with its ledger, and rolls everything back', async () => {
		const { lanyard } = await seedStore();
		const snapshot = await dataSnapshot.exportAll();
		const corrupt = { ...snapshot, products: snapshot.products.map((product) => (product._id === lanyard._id ? { ...product, stockQuantity: 999 } : product)) };
		const before = await stockOf(lanyard._id);

		await expect(restore(corrupt)).rejects.toMatchObject({ message: 'stock mismatch', mismatches: [expect.objectContaining({ productId: lanyard._id, cached: 999 })] });

		expect(await stockOf(lanyard._id)).toBe(before);
	});

	it('rejects a file that repeats a unique value, leaving the store as it was', async () => {
		await seedStore();
		const snapshot = await dataSnapshot.exportAll();
		const [first, second] = snapshot.products;
		const clash = { ...snapshot, products: [first, { ...second, publicCode: first.publicCode }, ...snapshot.products.slice(2)] };
		const before = await listProducts();

		const error = await restore(clash).catch((caught) => caught);

		expect(isDuplicateKeyError(error)).toBe(true);
		expect(await listProducts()).toEqual(before);
	});

	it('restores an empty file to an empty store', async () => {
		await seedStore();
		const empty = Object.fromEntries(SECTIONS.map((section) => [section, []]));

		await restore(empty);

		expect(await dataSnapshot.exportAll()).toEqual(empty);
		expect(await countRows('movement')).toBe(0);
		const product = await data.withTransaction((tx) => data.products.create({ name: 'Fresh', price: 1, category: 'c' }, 0, tx));
		const movement = await recordMovement({ productId: product._id, type: 'adjust', delta: 2, idempotencyKey: 'fresh', createdBy: 'a', reason: 'r' });
		expect((await applyMovement(movement._id)).applied).toBe(true);
	});

	it.skipIf(!POSTGRES)('numbers the restored movements past the sequence, so the next movement does not collide with one', async () => {
		const stamp = '2026-10-02T03:04:05.000Z';
		const product = { _id: newId(), name: 'Bulk', price: 1, category: 'c', stockQuantity: 40 };
		const ledger = Array.from({ length: 40 }, (_, index) => ({
			_id: newId(), productId: product._id, type: 'adjust', delta: 1, idempotencyKey: `bulk:${index}`, status: 'applied', appliedAt: stamp, stockAfter: index + 1, createdAt: stamp, createdBy: 'seed', reason: 'r', attempts: 0
		}));

		await restore({ products: [product], combos: [], orders: [], stockMovements: ledger, settings: [] });
		await recordMovement({ productId: product._id, type: 'adjust', delta: 1, idempotencyKey: 'after-bulk', createdBy: 'admin', reason: 'x' });

		const keys = (await movements()).map((movement) => movement.idempotencyKey);
		expect(keys).toHaveLength(41);
		expect(keys.slice(0, 40)).toEqual(ledger.map((movement) => movement.idempotencyKey));
		expect(keys.at(-1)).toBe('after-bulk');
	});

	it.skipIf(!POSTGRES)('gives a product from before public codes existed a code and a slug', async () => {
		const snapshot = await dataSnapshot.exportAll();
		const legacy = { _id: newId(), name: 'Áo thun cũ', price: 1000, category: 'cũ', stockQuantity: 0 };

		await restore({ ...snapshot, products: [legacy] });

		const stored = await findProduct(legacy._id);
		expect(stored.publicCode).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
		expect(stored.slug).toBe('ao-thun-cu');
	});
});

describe('a backup made before the migration', () => {
	// Mongo-format ids (24 hex) everywhere an id can appear.
	const H = {
		p1: '68f1a2b3c4d5e6f708192a31', p2: '68f1a2b3c4d5e6f708192a32', c1: '68f1a2b3c4d5e6f708192a33', r1: '68f1a2b3c4d5e6f708192a34',
		o1: '68f1a2b3c4d5e6f708192a35', o2: '68f1a2b3c4d5e6f708192a36', i0: '68f1a2b3c4d5e6f708192a37', i1: '68f1a2b3c4d5e6f708192a38',
		i2: '68f1a2b3c4d5e6f708192a39', i3: '68f1a2b3c4d5e6f708192a3a', i4: '68f1a2b3c4d5e6f708192a3b', h1: '68f1a2b3c4d5e6f708192a3c',
		h2: '68f1a2b3c4d5e6f708192a3d', u1: '68f1a2b3c4d5e6f708192a3e', m1: '68f1a2b3c4d5e6f708192a3f', m2: '68f1a2b3c4d5e6f708192a40',
		m3: '68f1a2b3c4d5e6f708192a41', s1: '68f1a2b3c4d5e6f708192a42'
	};
	const stamp = '2026-10-02T03:04:05.000Z';
	const link = (productId, quantity, extra = {}) => ({ productId, productName: productId === H.p1 ? 'Lanyard' : 'Badge', price: productId === H.p1 ? 10000 : 5000, quantity, ...extra });

	const legacyFile = () => ({
		products: [
			{ _id: H.p1, publicCode: generatePublicCode(), slug: 'lanyard', name: 'Lanyard', price: 10000, category: 'lanyard', stockQuantity: 4, tags: ['a'], dimensions: { length: 1, width: 2, height: 3 }, available: true, createdAt: stamp, updatedAt: stamp, __v: 0 },
			{ _id: H.p2, publicCode: generatePublicCode(), slug: 'badge', name: 'Badge', price: 5000, category: 'badge', stockQuantity: 0, createdAt: stamp, updatedAt: stamp, __v: 0 }
		],
		combos: [{
			_id: H.c1, publicCode: generatePublicCode(), slug: 'twin', name: 'Twin', price: 12000, isActive: true, priority: 1, createdAt: stamp, updatedAt: stamp, __v: 0,
			categoryRequirements: [{ _id: H.r1, category: 'lanyard', quantity: 1 }, { category: 'badge', quantity: 1 }]
		}],
		orders: [
			{
				_id: H.o1, orderCode: 'LEGACY1', studentId: 'SV1', fullName: 'Nguyen A', email: 'a@test.vn', phoneNumber: '0912345678', status: 'paid',
				items: [
					link(H.p1, 1, { _id: H.i1, fromCombo: true, comboId: H.c1, comboName: 'Twin' }),
					link(H.p2, 1, { _id: H.i2, fromCombo: true, comboId: H.c1, comboName: 'Twin' }),
					link(H.p2, 2, { _id: H.i3, fromCombo: false, comboId: null, comboName: null })
				],
				totalAmount: 22000, stockDeducted: true, itemsRevision: 2, lastUpdatedBy: 'admin', createdBy: H.u1,
				comboInfo: { savings: 3000, originalTotal: 15000, finalTotal: 12000, combos: [{ comboId: H.c1, comboName: 'Twin', applications: 1, savings: 3000 }] },
				statusHistory: [
					{ _id: H.h1, status: 'confirmed', updatedBy: 'system', updatedAt: stamp },
					{ _id: H.h2, status: 'paid', updatedBy: 'admin', updatedAt: stamp, note: 'đã nhận tiền' }
				],
				internalNotes: [{ note: 'Hẹn thứ Sáu', by: 'admin', at: stamp }],
				itemsHistory: [
					{ previousItems: [link(H.p1, 3, { _id: H.i0, fromCombo: false, comboId: null, comboName: null })], previousComboInfo: null, editedBy: 'admin', editedAt: stamp, reason: 'đổi' },
					{ previousItems: [link(H.p2, 1, { _id: H.i4, comboId: H.c1 })], previousComboInfo: { finalTotal: 1, combos: [{ comboId: H.c1, comboName: 'Twin', applications: 1, savings: 0 }] }, editedBy: 'admin', editedAt: stamp, reason: 'đổi lại' }
				],
				statusUpdatedAt: stamp, createdAt: stamp, updatedAt: stamp, __v: 4
			},
			{
				_id: H.o2, orderCode: 'D100001', isDirectSale: true, fullName: 'NB: seller', status: 'confirmed', stockDeducted: false, totalAmount: 15000,
				items: [link(H.p2, 3)], comboInfo: null, statusHistory: [], internalNotes: [], itemsHistory: [], createdAt: stamp, updatedAt: stamp, __v: 0
			}
		],
		stockMovements: [
			{ _id: H.m1, productId: H.p1, type: 'opening', delta: 5, idempotencyKey: `opening:${H.p1}`, status: 'applied', appliedAt: stamp, stockAfter: 5, createdBy: 'seed', reason: 'seed', attempts: 0, createdAt: stamp, __v: 0 },
			{ _id: H.m2, productId: H.p1, type: 'order', delta: -1, orderId: H.o1, idempotencyKey: `order:${H.o1}:${H.p1}:create`, status: 'applied', appliedAt: stamp, stockAfter: 4, createdBy: 'system', reason: 'Đơn LEGACY1', attempts: 1, createdAt: stamp, __v: 0 },
			{ _id: H.m3, productId: H.p2, type: 'order', delta: -3, orderId: H.o1, idempotencyKey: `order:${H.o1}:${H.p2}:create`, status: 'pending', createdBy: 'system', reason: 'Đơn LEGACY1', attempts: 0, createdAt: stamp, __v: 0 }
		],
		settings: [{ _id: H.s1, key: 'payment_config', bankNameId: '970436', bankAccountId: '1', prefixMessage: 'SAB', updatedBy: 'admin', createdAt: stamp, updatedAt: stamp, __v: 0 }]
	});

	it('is a valid file to begin with', () => {
		const file = legacyFile();
		expect(validateSnapshot(fileOf(file).metadata, file)).toEqual([]);
	});

	it('restores with every id mapped the same way: rows, references, JSON and idempotency keys', async () => {
		const file = legacyFile();

		const written = await restore(file);

		expect(written).toEqual({ products: 2, combos: 1, orders: 2, stockMovements: 3, settings: 1 });
		expect((await findProduct(mapped(H.p1))).stockQuantity).toBe(4);
		expect((await findCombo(mapped(H.c1))).categoryRequirements[0]._id).toBe(mapped(H.r1));

		const order = await findOrder(mapped(H.o1));
		expect(order.createdBy).toBe(mapped(H.u1));
		expect(order.items.map((item) => [String(item._id), String(item.productId), item.comboId && String(item.comboId)])).toEqual([
			[mapped(H.i1), mapped(H.p1), mapped(H.c1)], [mapped(H.i2), mapped(H.p2), mapped(H.c1)], [mapped(H.i3), mapped(H.p2), null]
		]);
		expect(order.statusHistory.map((entry) => String(entry._id))).toEqual([mapped(H.h1), mapped(H.h2)]);
		expect(String(order.comboInfo.combos[0].comboId)).toBe(mapped(H.c1));
		expect(order.itemsHistory.map((entry) => entry.reason)).toEqual(['đổi', 'đổi lại']);
		expect(String(order.itemsHistory[0].previousItems[0].productId)).toBe(mapped(H.p1));
		expect(String(order.itemsHistory[0].previousItems[0]._id)).toBe(mapped(H.i0));
		expect(String(order.itemsHistory[1].previousItems[0].comboId)).toBe(mapped(H.c1));
		expect(String(order.itemsHistory[1].previousComboInfo.combos[0].comboId)).toBe(mapped(H.c1));
		expect(order.internalNotes).toHaveLength(1);

		const ledger = await movements();
		expect(ledger.map((movement) => movement.idempotencyKey)).toEqual([
			`opening:${mapped(H.p1)}`, `order:${mapped(H.o1)}:${mapped(H.p1)}:create`, `order:${mapped(H.o1)}:${mapped(H.p2)}:create`
		]);
		expect(ledger.map((movement) => String(movement.productId))).toEqual([mapped(H.p1), mapped(H.p1), mapped(H.p2)]);
		expect(ledger.map((movement) => (movement.orderId ? String(movement.orderId) : null))).toEqual([null, mapped(H.o1), mapped(H.o1)]);
		expect(ledger.map((movement) => String(movement._id))).toEqual([mapped(H.m1), mapped(H.m2), mapped(H.m3)]);
		expect(String((await findSettings())._id)).toBe(mapped(H.s1));
		const direct = await findOrder(mapped(H.o2));
		expect(String(direct._id)).toBe(mapped(H.o2));
		expect(direct.items.map((item) => String(item.productId))).toEqual([mapped(H.p2)]);
		expect(await reconcile()).toEqual([]);
	});

	it('exports the restored file as a valid file that restores to itself', async () => {
		await restore(legacyFile());

		const exported = await dataSnapshot.exportAll();

		expect(validateSnapshot(fileOf(exported).metadata, exported)).toEqual([]);
		if (POSTGRES) {
			expect(JSON.stringify(exported)).not.toMatch(/"[0-9a-f]{24}"/);
			expect(exported.products.map((product) => product._id).sort()).toEqual([mapped(H.p1), mapped(H.p2)].sort());
		}
		await restore(exported);
		expect(await dataSnapshot.exportAll()).toEqual(exported);
	});

	it.skipIf(!POSTGRES)('drops the storage version key and an empty phone number', async () => {
		const file = legacyFile();
		file.orders[1].phoneNumber = '';

		await restore(file);

		const exported = await dataSnapshot.exportAll();
		expect(JSON.stringify(exported)).not.toMatch(/__v/);
		expect(exported.orders.find((order) => order.orderCode === 'D100001')).not.toHaveProperty('phoneNumber');
		expect(await listCombos()).toHaveLength(1);
		expect((await findSettings()).bankNameId).toBe('970436');
	});
});
