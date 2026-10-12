/**
 * The MongoDB -> PostgreSQL loader, fed documents shaped the way the MongoDB
 * driver returns them (ObjectId and Date values; a user reference stored either
 * as an ObjectId or, as the old Account model did, as its hex string). The
 * target is the suite's empty Postgres database.
 */
const { ObjectId } = require('mongodb');
const { objectIdToUuidV7 } = require('@sab/shared');
const { POSTGRES } = require('../helpers/backend');
const { countTables } = require('../../scripts/migrate-mongo/tables');

// The loader writes through the Postgres repositories; a mongo run has none.
const suite = describe.skipIf(!POSTGRES);

const uuid = (oid) => objectIdToUuidV7(oid.toHexString());
const at = (iso) => new Date(iso);
const HOUR = 60 * 60 * 1000;
const NOW = at('2026-10-12T05:00:00.000Z');
const PASSWORD_HASH = 'aa11:bb22'; // shape only; never checked against a password here

function fixture() {
	const ids = {
		p1: new ObjectId(), p2: new ObjectId(), c1: new ObjectId(), o1: new ObjectId(), o2: new ObjectId(), o3: new ObjectId(),
		admin: new ObjectId(), seller: new ObjectId(), banned: new ObjectId()
	};
	const earlier = at('2026-09-01T02:00:00.000Z');
	const created = at('2026-09-01T03:00:00.000Z');
	const later = at('2026-09-01T04:00:00.000Z');
	const store = {
		products: [
			{
				_id: ids.p1, publicCode: 'ABCD2345', slug: 'ao-thun', name: 'Áo thun', price: 20000, category: 'shirt',
				stockQuantity: 8, available: true, tags: ['new'], dimensions: { length: 1.5 }, createdAt: created, updatedAt: created, __v: 0
			},
			// From before public codes and update stamps existed.
			{ _id: ids.p2, name: 'Nón', price: 15000, category: 'hat', stockQuantity: 0, createdAt: created }
		],
		combos: [{
			_id: ids.c1, publicCode: 'EFGH6789', slug: 'combo', name: 'Combo', price: 30000, isActive: true, priority: 1,
			categoryRequirements: [{ _id: new ObjectId(), category: 'shirt', quantity: 1 }, { _id: new ObjectId(), category: 'hat', quantity: 1 }],
			createdAt: created, updatedAt: created, __v: 0
		}],
		orders: [
			// A direct sale from before `stockDeducted` was stored.
			{
				_id: ids.o1, orderCode: 'AAA111', orderNumber: 'S-1', isDirectSale: true, createdBy: ids.seller, status: 'delivered',
				items: [{ _id: new ObjectId(), productId: ids.p1, productName: 'Áo thun', price: 20000, quantity: 2 }],
				totalAmount: 40000,
				statusHistory: [{ _id: new ObjectId(), status: 'delivered', updatedBy: 'seller_one', updatedAt: created }],
				internalNotes: [{ note: 'ghi chú', by: 'admin@test.local', at: created }],
				itemsHistory: [{
					previousItems: [{ productId: ids.p2, productName: 'Nón', price: 15000, quantity: 1 }],
					editedBy: 'admin@test.local', editedAt: created, reason: 'đổi hàng'
				}],
				itemsRevision: 1, statusUpdatedAt: created, comboInfo: null, createdAt: created, updatedAt: created, __v: 0
			},
			// An online combo order with an empty phone and no `statusUpdatedAt`.
			{
				_id: ids.o2, orderCode: 'BBB222', phoneNumber: '', studentId: '2212345', fullName: 'Khách', email: 'k@test.local',
				status: 'paid', stockDeducted: false,
				items: [
					{ _id: new ObjectId(), productId: ids.p1, productName: 'Áo thun', price: 20000, quantity: 1, fromCombo: true, comboId: ids.c1, comboName: 'Combo' },
					{ _id: new ObjectId(), productId: ids.p2, productName: 'Nón', price: 15000, quantity: 1, fromCombo: true, comboId: ids.c1, comboName: 'Combo' }
				],
				comboInfo: { comboId: ids.c1, comboName: 'Combo', finalTotal: 30000, savings: 5000 },
				totalAmount: 30000,
				statusHistory: [
					{ _id: new ObjectId(), status: 'confirmed', updatedBy: 'system', updatedAt: created },
					{ _id: new ObjectId(), status: 'paid', updatedBy: 'admin@test.local', updatedAt: later }
				],
				createdAt: created, updatedAt: created, __v: 0
			},
			// A cancelled direct sale from before `stockDeducted`: its units are back.
			{
				_id: ids.o3, orderCode: 'CCC333', isDirectSale: true, status: 'cancelled', cancelReason: 'khách đổi ý',
				items: [{ _id: new ObjectId(), productId: ids.p2, productName: 'Nón', price: 15000, quantity: 1 }],
				totalAmount: 15000, statusUpdatedAt: created, createdAt: created, updatedAt: created
			}
		],
		// Not in ledger order: the loader must number them by (createdAt, _id).
		stockMovements: [
			{
				_id: new ObjectId(), productId: ids.p1, type: 'order', delta: -2, orderId: ids.o1,
				idempotencyKey: `order:${ids.o1.toHexString()}:${ids.p1.toHexString()}`,
				status: 'applied', appliedAt: created, stockAfter: 8, attempts: 1, createdBy: 'seller_one', reason: '', createdAt: created, __v: 0
			},
			{
				_id: new ObjectId(), productId: ids.p2, type: 'set_target', target: 5, delta: null, idempotencyKey: 'set:manual-1',
				status: 'pending', attempts: 0, createdBy: 'admin@test.local', reason: 'kiểm kê', createdAt: later, __v: 0
			},
			{
				_id: new ObjectId(), productId: ids.p1, type: 'opening', delta: 10, idempotencyKey: `opening:${ids.p1.toHexString()}`,
				status: 'applied', appliedAt: earlier, stockAfter: 10, attempts: 0, createdBy: 'system', reason: '', createdAt: earlier, __v: 0
			}
		],
		settings: [{ _id: new ObjectId(), key: 'payment_config', bankNameId: 'VCB', bankAccountId: '0123', createdAt: created, updatedAt: created, __v: 0 }]
	};
	const auth = {
		user: [
			{ _id: ids.admin, name: 'Admin', email: 'admin@test.local', emailVerified: true, username: 'admin', role: 'admin', createdAt: created, updatedAt: created },
			{ _id: ids.seller, name: 'Seller', email: 'seller@test.local', username: 'Seller_One', role: 'seller', createdAt: created, updatedAt: created, __v: 0 },
			{
				_id: ids.banned, name: 'Banned', email: 'banned@test.local', emailVerified: false, username: 'banned', role: 'user',
				banned: true, banReason: 'spam', banExpires: at('2026-10-01T00:00:00.000Z'), createdAt: created, updatedAt: created
			}
		],
		account: [
			{ _id: new ObjectId(), accountId: ids.admin.toHexString(), providerId: 'credential', userId: ids.admin, password: PASSWORD_HASH, createdAt: created, updatedAt: created },
			// The old Account model typed userId as a string; this one also lacks updatedAt.
			{ _id: new ObjectId(), accountId: ids.seller.toHexString(), providerId: 'credential', userId: ids.seller.toHexString(), password: 'cc33:dd44', createdAt: created },
			// Another provider's accountId is that provider's id and stays as it is.
			{ _id: new ObjectId(), accountId: 'google-1234', providerId: 'google', userId: ids.banned, createdAt: created, updatedAt: created }
		],
		session: [
			{
				_id: new ObjectId(), token: 'live-token', expiresAt: new Date(NOW.getTime() + HOUR), userId: ids.seller, impersonatedBy: ids.admin,
				ipAddress: '127.0.0.1', createdAt: created, updatedAt: created
			},
			{ _id: new ObjectId(), token: 'old-token', expiresAt: new Date(NOW.getTime() - HOUR), userId: ids.admin, createdAt: created, updatedAt: created }
		],
		verification: [
			{ _id: new ObjectId(), identifier: 'reset', value: 'live', expiresAt: new Date(NOW.getTime() + HOUR), createdAt: created, updatedAt: created },
			{ _id: new ObjectId(), identifier: 'reset', value: 'gone', expiresAt: new Date(NOW.getTime() - HOUR), createdAt: created, updatedAt: created }
		],
		jwks: [{ _id: new ObjectId(), publicKey: '{"kty":"OKP"}', privateKey: '"encrypted"', createdAt: created }]
	};
	return { ids, created, later, source: { store, auth, others: {} } };
}

suite('migrate-mongo-to-postgres loader', () => {
	let prisma;
	let migrate;
	let compareStore;

	beforeAll(() => {
		({ prisma } = require('../../lib/prisma'));
		({ migrate } = require('../../scripts/migrate-mongo/load'));
		({ compareStore } = require('../../scripts/migrate-mongo/compare'));
	});

	// Every table the loader writes, so "nothing written" covers the child and auth tables too.
	const tables = () => countTables(prisma);
	const isEmpty = async () => Object.values(await tables()).every((n) => n === 0);

	const LOADED = {
		user: 3, account: 3, session: 1, verification: 1, jwks: 1,
		products: 2, combos: 1, combo_category_requirements: 2,
		orders: 3, order_items: 4, order_status_history: 3, order_internal_notes: 1, order_items_edits: 1,
		stock_movements: 3, settings: 1
	};

	it('dry run verifies everything and writes nothing', async () => {
		const { source } = fixture();
		const result = await migrate(source, { now: NOW });

		expect(result.problems).toEqual([]);
		expect(result).toMatchObject({ ok: true, committed: false });
		expect(result.report.counts).toEqual(LOADED);
		expect(await isEmpty()).toBe(true);
	});

	it('--apply commits the logins under mapped ids', async () => {
		const { ids, created, source } = fixture();
		const result = await migrate(source, { apply: true, now: NOW });
		expect(result.problems).toEqual([]);
		expect(result.committed).toBe(true);
		expect(await tables()).toEqual(LOADED);

		const seller = await prisma.user.findUnique({ where: { id: uuid(ids.seller) } });
		expect(seller).toMatchObject({ username: 'seller_one', displayUsername: 'Seller_One', emailVerified: false, role: 'seller' });
		expect(await prisma.user.findUnique({ where: { id: uuid(ids.banned) } })).toMatchObject({ banned: true, banReason: 'spam' });
		expect(result.report.auth).toEqual({ lowercasedUsernames: 1, bannedUsers: 1, expiredBans: 1, droppedExpiredSessions: 1, droppedExpiredVerifications: 1 });

		const accounts = new Map((await prisma.account.findMany()).map((a) => [a.userId, a]));
		expect(accounts.get(uuid(ids.admin))).toMatchObject({ accountId: uuid(ids.admin), password: PASSWORD_HASH });
		expect(accounts.get(uuid(ids.seller))).toMatchObject({ accountId: uuid(ids.seller), updatedAt: created });
		expect(accounts.get(uuid(ids.banned))).toMatchObject({ providerId: 'google', accountId: 'google-1234', password: null });

		expect(await prisma.session.findMany({ select: { token: true, userId: true, impersonatedBy: true } }))
			.toEqual([{ token: 'live-token', userId: uuid(ids.seller), impersonatedBy: uuid(ids.admin) }]);
		expect(await prisma.verification.findMany({ select: { value: true } })).toEqual([{ value: 'live' }]);
		expect((await prisma.jwks.findFirst()).createdAt).toEqual(created);
	});

	it('--apply commits the store with legacy gaps repaired', async () => {
		const { ids, later, source } = fixture();
		const result = await migrate(source, { apply: true, now: NOW });
		expect(result.committed).toBe(true);
		expect(result.report.repairs).toEqual({ publicCode: 1, updatedAt: 1, stockDeducted: 2, statusUpdatedAt: 1 });

		const legacy = await prisma.product.findUnique({ where: { id: uuid(ids.p2) } });
		expect(legacy.publicCode).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
		expect(legacy.updatedAt).toEqual(legacy.createdAt);

		const direct = await prisma.order.findUnique({ where: { id: uuid(ids.o1) }, include: { itemsEdits: true } });
		expect(direct).toMatchObject({ stockDeducted: true, createdBy: uuid(ids.seller) });
		expect(direct.itemsEdits[0].previousItems[0].productId).toBe(uuid(ids.p2));
		expect(await prisma.order.findUnique({ where: { id: uuid(ids.o3) } })).toMatchObject({ stockDeducted: false, status: 'cancelled' });
		const online = await prisma.order.findUnique({ where: { id: uuid(ids.o2) } });
		expect(online).toMatchObject({ phoneNumber: null, statusUpdatedAt: later });
		expect(online.comboInfo.comboId).toBe(uuid(ids.c1));

		// Numbered in ledger order, with the ids inside the keys mapped.
		const keys = (await prisma.stockMovement.findMany({ orderBy: { seq: 'asc' } })).map((m) => m.idempotencyKey);
		expect(keys).toEqual([`opening:${uuid(ids.p1)}`, `order:${uuid(ids.o1)}:${uuid(ids.p1)}`, 'set:manual-1']);
		// The sequence is past the loaded rows, so the next movement inserts.
		const next = await prisma.stockMovement.create({ data: { productId: uuid(ids.p1), type: 'adjust', delta: 1, idempotencyKey: 'after-load' } });
		expect(next.seq).toBeGreaterThan(3);
	});

	it('refuses a target that already holds rows', async () => {
		const first = await migrate(fixture().source, { apply: true, now: NOW });
		expect(first.committed).toBe(true);
		const before = await tables();

		const again = await migrate(fixture().source, { apply: true, now: NOW });
		expect(again).toMatchObject({ ok: false, committed: false });
		expect(again.problems.join('\n')).toMatch(/không trống/);
		expect(await tables()).toEqual(before);
	});

	it('rolls back every write when the ledger disagrees with a stock cache', async () => {
		const { source } = fixture();
		source.store.products[0].stockQuantity = 9;

		const result = await migrate(source, { apply: true, now: NOW });
		expect(result).toMatchObject({ ok: false, committed: false });
		expect(result.problems.join('\n')).toMatch(/tồn kho 9, lịch sử nhập xuất cho 8/);
		expect(await isEmpty()).toBe(true);
	});

	it('rolls back the auth rows already inserted when a unique column repeats in the store', async () => {
		const { source } = fixture();
		source.store.products[1].publicCode = 'ABCD2345';

		const result = await migrate(source, { apply: true, now: NOW });
		expect(result).toMatchObject({ ok: false, committed: false });
		expect(result.problems).toEqual([expect.stringMatching(/Giá trị trùng ở cột unique: .*public_?code/i)]);
		expect(await isEmpty()).toBe(true);
	});

	// Each case breaks one rule; nothing reaches the database.
	const BROKEN = [
		['an unknown field on a user', (s) => { s.auth.user[0].nickname = 'x'; }, /user .*: trường "nickname" không được nhận diện/],
		['a stray _id on an internal note', (s) => { s.store.orders[0].internalNotes[0]._id = new ObjectId(); }, /internalNotes\[0\]: trường "_id" không được nhận diện/],
		['a non-integer price', (s) => { s.store.products[0].price = 19999.5; }, /products\[0\]\.price phải là số nguyên/],
		['an unknown order status', (s) => { s.store.orders[0].status = 'pending'; }, /orders\[0\]\.status phải là một trong/],
		['a credential account whose accountId is not its user', (s) => { s.auth.account[0].accountId = new ObjectId().toHexString(); }, /accountId của tài khoản credential khác userId/],
		['a credential account without a password', (s) => { delete s.auth.account[1].password; }, /tài khoản credential thiếu mật khẩu/],
		['an account of no user', (s) => { s.auth.account[1].userId = new ObjectId(); }, /userId trỏ tới người dùng không tồn tại/],
		['usernames equal but for case', (s) => { s.auth.user[2].username = 'SELLER_ONE'; }, /trùng username/],
		['a capitalised email', (s) => { s.auth.user[0].email = 'Admin@test.local'; }, /email không ở dạng chữ thường/],
		['an unknown role', (s) => { s.auth.user[0].role = 'owner'; }, /role không hợp lệ/],
		['a date stored as text', (s) => { s.auth.user[2].banExpires = '2026-10-01'; }, /banExpires phải là ngày giờ/],
		['a text column holding an object', (s) => { s.auth.user[0].image = { url: 'x' }; }, /image phải là chuỗi/],
		['a live session of no user', (s) => { s.auth.session[0].userId = new ObjectId(); }, /session .*userId trỏ tới người dùng không tồn tại/],
		['a session impersonated by no user', (s) => { s.auth.session[0].impersonatedBy = new ObjectId(); }, /impersonatedBy trỏ tới người dùng không tồn tại/],
		['two live sessions with one token', (s) => { s.auth.session[1].token = 'live-token'; s.auth.session[1].expiresAt = new Date(NOW.getTime() + HOUR); }, /trùng token/],
		['a non-empty collection the loader does not take', (s) => { s.others.carts = 2; }, /Collection "carts" \(2 bản ghi\)/]
	];

	it.each(BROKEN)('refuses %s', async (_label, breakIt, message) => {
		const { source } = fixture();
		breakIt(source);
		const result = await migrate(source, { apply: true, now: NOW });

		expect(result.ok).toBe(false);
		expect(result.problems.join('\n')).toMatch(message);
		expect(await isEmpty()).toBe(true);
	});

	describe('read-back comparison', () => {
		const hex = '650000000000000000000001';
		const id = objectIdToUuidV7(hex);

		it('accepts mapped ids, a dropped empty phone and Postgres-only defaults', () => {
			const source = { orders: [{ _id: hex, phoneNumber: '', comboInfo: { combos: [{ comboId: hex }] }, cancelReason: null }] };
			const exported = { orders: [{ _id: id, comboInfo: { combos: [{ comboId: id }] }, status: 'confirmed' }] };
			expect(compareStore(source, exported)).toEqual([]);
		});

		it('reports a lost field, a changed value and a missing record by path', () => {
			const source = { products: [{ _id: hex, name: 'A', price: 1, tags: ['x'] }] };
			expect(compareStore(source, { products: [{ _id: id, name: 'A', price: 1 }] })).toEqual([`products ${hex}: tags đọc lại khác nguồn`]);
			expect(compareStore(source, { products: [{ _id: id, name: 'A', price: 2, tags: ['x'] }] })).toEqual([`products ${hex}: price đọc lại khác nguồn`]);
			expect(compareStore(source, { products: [] })).toEqual([`products ${hex}: (không có bản ghi) đọc lại khác nguồn`]);
		});
	});
});
