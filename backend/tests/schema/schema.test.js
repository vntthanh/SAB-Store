/**
 * The migrated schema as the database enforces it: uniques, enums, cascades,
 * the CHECKs and the partial index Prisma cannot model, id generation and the
 * stock movement sequence. Raw SQL on purpose: these rules must hold for any
 * writer, not only for code that goes through the Prisma client.
 */
const { Client } = require('pg');
const postgres = require('../helpers/postgres');

const HEX_ID = /^[0-9a-f]{24}$/;
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const INVALID_ENUM = '22P02';

let db;

beforeAll(async () => {
	db = new Client({ connectionString: process.env.DATABASE_URL, options: postgres.POOL_OPTIONS });
	await db.connect();
});

afterAll(async () => {
	await db.end();
});

async function insert(table, row) {
	const columns = Object.keys(row);
	const sql = `INSERT INTO ${db.escapeIdentifier(table)} (${columns.map((c) => db.escapeIdentifier(c)).join(', ')})
		VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
	const { rows } = await db.query(sql, Object.values(row));
	return rows[0];
}

let counter = 0;
const next = () => ++counter;

const product = (overrides = {}) =>
	insert('products', {
		name: 'Bánh mì',
		price: 15000,
		category: 'food',
		public_code: `PC${String(next()).padStart(6, '0')}`,
		slug: 'banh-mi',
		...overrides,
	});

const combo = (overrides = {}) =>
	insert('combos', { name: 'Combo', price: 30000, public_code: `CB${String(next()).padStart(6, '0')}`, slug: 'combo', ...overrides });

const order = (overrides = {}) =>
	insert('orders', { order_code: `OD${String(next()).padStart(6, '0')}`, total_amount: 30000, ...overrides });

const movement = (overrides = {}) =>
	insert('stock_movements', {
		product_id: 'p'.repeat(24),
		type: 'order',
		delta: -1,
		idempotency_key: `key-${next()}`,
		...overrides,
	});

const count = async (table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

describe('migration ledger', () => {
	it('records the applied migrations, so the template was built by migrate deploy', async () => {
		const { rows } = await db.query('SELECT migration_name, finished_at FROM _prisma_migrations');
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.finished_at !== null)).toBe(true);
	});

	it('stores every timestamp as timestamptz', async () => {
		const { rows } = await db.query(
			`SELECT table_name, column_name, data_type FROM information_schema.columns
			 WHERE table_schema = 'public' AND data_type LIKE 'timestamp%' AND table_name <> '_prisma_migrations'`
		);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.filter((r) => r.data_type !== 'timestamp with time zone')).toEqual([]);
	});
});

describe('ids', () => {
	it('gives rows created without an id a 24-character lowercase hex id', async () => {
		const rows = [await product(), await combo(), await order(), await movement()];
		for (const row of rows) expect(row.id).toMatch(HEX_ID);
		expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
	});

	it('keeps an explicit migrated id as is', async () => {
		const row = await product({ id: '5f1d7f3e9b1c2a0012345678' });
		expect(row.id).toBe('5f1d7f3e9b1c2a0012345678');
	});
});

describe('unique constraints', () => {
	it('rejects a duplicate order code, product public code and idempotency key', async () => {
		await order({ order_code: 'AB12CD' });
		await expect(order({ order_code: 'AB12CD' })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

		await product({ public_code: 'SAMECODE' });
		await expect(product({ public_code: 'SAMECODE' })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

		await combo({ public_code: 'COMBOONE' });
		await expect(combo({ public_code: 'COMBOONE' })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

		await movement({ idempotency_key: 'order:1:2:create' });
		await expect(movement({ idempotency_key: 'order:1:2:create' })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
	});

	it('allows many NULL sku and order numbers but not a repeated value', async () => {
		await product({ sku: null });
		await product({ sku: null });
		await order({ order_number: null });
		await order({ order_number: null });
		expect(await count('products')).toBe(2);
		expect(await count('orders')).toBe(2);

		await product({ sku: 'SKU-1' });
		await expect(product({ sku: 'SKU-1' })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
		await order({ order_number: 'N-1' });
		await expect(order({ order_number: 'N-1' })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
	});

	it('keeps one position per order child and per combo requirement', async () => {
		const o = await order();
		await insert('order_items', { order_id: o.id, position: 0, product_id: 'x', product_name: 'x', price: 1, quantity: 1 });
		await expect(
			insert('order_items', { order_id: o.id, position: 0, product_id: 'y', product_name: 'y', price: 1, quantity: 1 })
		).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

		const c = await combo();
		await insert('combo_category_requirements', { combo_id: c.id, position: 0, category: 'food', quantity: 1 });
		await expect(
			insert('combo_category_requirements', { combo_id: c.id, position: 0, category: 'drink', quantity: 1 })
		).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
	});
});

describe('enums', () => {
	it('rejects values outside the four order statuses, including the legacy pending', async () => {
		await expect(order({ status: 'pending' })).rejects.toMatchObject({ code: INVALID_ENUM });
		const o = await order({ status: 'paid' });
		await expect(
			insert('order_status_history', { order_id: o.id, position: 0, status: 'pending', updated_by: 'x' })
		).rejects.toMatchObject({ code: INVALID_ENUM });
	});

	it('rejects an unknown sales channel, movement type and movement status', async () => {
		await expect(product({ sales_channel: 'phone' })).rejects.toMatchObject({ code: INVALID_ENUM });
		await expect(combo({ sales_channel: 'phone' })).rejects.toMatchObject({ code: INVALID_ENUM });
		await expect(movement({ type: 'refund' })).rejects.toMatchObject({ code: INVALID_ENUM });
		await expect(movement({ status: 'failed' })).rejects.toMatchObject({ code: INVALID_ENUM });
	});

	it('defaults a missing channel to all and a missing order status to confirmed', async () => {
		expect((await product()).sales_channel).toBe('all');
		expect((await order()).status).toBe('confirmed');
	});
});

describe('foreign keys', () => {
	it('deletes every child row with its order', async () => {
		const o = await order();
		await insert('order_items', { order_id: o.id, position: 0, product_id: 'x', product_name: 'x', price: 1, quantity: 1 });
		await insert('order_status_history', { order_id: o.id, position: 0, status: 'confirmed', updated_by: 'system' });
		await insert('order_internal_notes', { order_id: o.id, position: 0, note: 'n', by: 'admin' });
		await insert('order_items_edits', {
			order_id: o.id,
			position: 0,
			previous_items: JSON.stringify([{ productId: 'x' }]),
			edited_by: 'admin',
			reason: 'fix',
		});

		await db.query('DELETE FROM orders WHERE id = $1', [o.id]);

		for (const table of ['order_items', 'order_status_history', 'order_internal_notes', 'order_items_edits']) {
			expect(await count(table)).toBe(0);
		}
	});

	it('deletes combo requirements with their combo', async () => {
		const c = await combo();
		await insert('combo_category_requirements', { combo_id: c.id, position: 0, category: 'food', quantity: 2 });
		await db.query('DELETE FROM combos WHERE id = $1', [c.id]);
		expect(await count('combo_category_requirements')).toBe(0);
	});

	it('lets orders and the stock ledger outlive a deleted product', async () => {
		const p = await product();
		const o = await order();
		await insert('order_items', { order_id: o.id, position: 0, product_id: p.id, product_name: 'x', price: 1, quantity: 1 });
		await movement({ product_id: p.id });

		await db.query('DELETE FROM products WHERE id = $1', [p.id]);

		expect(await count('order_items')).toBe(1);
		expect(await count('stock_movements')).toBe(1);
	});

	it('rejects an order child whose order does not exist', async () => {
		await expect(
			insert('order_items', { order_id: 'f'.repeat(24), position: 0, product_id: 'x', product_name: 'x', price: 1, quantity: 1 })
		).rejects.toMatchObject({ code: '23503' });
	});
});

describe('check constraints', () => {
	it('exist under their names', async () => {
		const { rows } = await db.query(`SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace`);
		expect(rows.map((r) => r.conname).sort()).toEqual([
			'combo_category_requirements_quantity_check',
			'combos_price_check',
			'order_items_price_check',
			'order_items_quantity_check',
			'orders_phone_number_check',
			'orders_total_amount_check',
			'products_min_order_quantity_check',
			'products_price_check',
			'products_sale_price_check',
			'products_weight_check',
			'stock_movements_set_target_shape_check',
		]);
	});

	it('requires a Vietnamese 10-digit phone number, and allows none for a direct sale', async () => {
		for (const phone of ['123456789', '0123', '01234567890', '0abcdefghi', '1234567890']) {
			await expect(order({ phone_number: phone })).rejects.toMatchObject({ code: CHECK_VIOLATION });
		}
		await order({ phone_number: '0912345678' });
		await order({ phone_number: null });
	});

	it('requires positive quantities and a minimum order of at least one', async () => {
		const o = await order();
		await expect(
			insert('order_items', { order_id: o.id, position: 0, product_id: 'x', product_name: 'x', price: 1, quantity: 0 })
		).rejects.toMatchObject({ code: CHECK_VIOLATION });
		const c = await combo();
		await expect(
			insert('combo_category_requirements', { combo_id: c.id, position: 0, category: 'food', quantity: 0 })
		).rejects.toMatchObject({ code: CHECK_VIOLATION });
		await expect(product({ min_order_quantity: 0 })).rejects.toMatchObject({ code: CHECK_VIOLATION });
	});

	it('rejects negative money: product, sale and combo prices, order totals and line prices', async () => {
		await expect(product({ price: -1 })).rejects.toMatchObject({ code: CHECK_VIOLATION });
		await expect(product({ sale_price: -1 })).rejects.toMatchObject({ code: CHECK_VIOLATION });
		await expect(combo({ price: -1 })).rejects.toMatchObject({ code: CHECK_VIOLATION });
		await expect(order({ total_amount: -1 })).rejects.toMatchObject({ code: CHECK_VIOLATION });
		const o = await order();
		await expect(
			insert('order_items', { order_id: o.id, position: 0, product_id: 'x', product_name: 'x', price: -1, quantity: 1 })
		).rejects.toMatchObject({ code: CHECK_VIOLATION });

		await product({ price: 0, sale_price: 0 });
		await product({ sale_price: null });
		await combo({ price: 0 });
		await order({ total_amount: 0 });
	});

	it('rejects a negative weight but accepts none', async () => {
		await expect(product({ weight: -1 })).rejects.toMatchObject({ code: CHECK_VIOLATION });
		await product({ weight: 0 });
		await product({ weight: null });
	});

	it('shapes set_target movements: a target and no delta while pending, a delta on every other type', async () => {
		await movement({ type: 'set_target', delta: null, target: 5 });
		await movement({ type: 'set_target', delta: 2, target: 5, status: 'applied' });
		await movement({ type: 'adjust', delta: 3 });

		await expect(movement({ type: 'set_target', delta: null, target: null })).rejects.toMatchObject({ code: CHECK_VIOLATION });
		await expect(movement({ type: 'set_target', delta: 2, target: 5 })).rejects.toMatchObject({ code: CHECK_VIOLATION });
		await expect(movement({ type: 'adjust', delta: null })).rejects.toMatchObject({ code: CHECK_VIOLATION });
		await expect(movement({ type: 'adjust', delta: 3, target: 5 })).rejects.toMatchObject({ code: CHECK_VIOLATION });
	});
});

describe('stock', () => {
	it('allows negative stock: an order is never refused for lack of it', async () => {
		const p = await product({ stock_quantity: -4 });
		expect(p.stock_quantity).toBe(-4);
	});

	it('has a partial pending_by_age index over pending movements only', async () => {
		const { rows } = await db.query(
			`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'stock_movements' AND indexname = 'pending_by_age'`
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].indexdef).toMatch(/\(seq\)/);
		expect(rows[0].indexdef).toMatch(/WHERE \(status = 'pending'::movement_status\)/);
	});

	it('numbers movements in insertion order', async () => {
		const seqs = [];
		for (let i = 0; i < 4; i++) seqs.push((await movement()).seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(4);
	});

	it('continues after a bulk load with explicit seq values once the sequence is moved past them', async () => {
		// The loader copies rows with the seq they had, which leaves the sequence at
		// its start. Without the setval the next order's movement would take seq 1
		// and fail the unique index.
		for (const seq of [1, 2, 3]) await movement({ seq });
		await expect(movement()).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

		await db.query(`SELECT setval(pg_get_serial_sequence('stock_movements', 'seq'), max(seq)) FROM stock_movements`);

		const fresh = await movement();
		expect(fresh.seq).toBe(4);
	});
});

describe('products.tags', () => {
	it('is never NULL: omitted means an empty list, an explicit NULL is refused', async () => {
		expect((await product()).tags).toEqual([]);
		await expect(product({ tags: null })).rejects.toMatchObject({ code: '23502' });
	});
});

describe('auth tables', () => {
	const user = (overrides = {}) =>
		insert('user', {
			id: `u${String(next()).padStart(8, '0')}`,
			name: 'Fake Person',
			email: `fake${next()}@example.invalid`,
			username: `fake_user_${next()}`,
			...overrides,
		});
	const session = (userId, overrides = {}) =>
		insert('session', {
			id: `s${next()}`,
			expiresAt: new Date('2030-01-01T00:00:00Z'),
			token: `fake-token-${next()}`,
			updatedAt: new Date('2026-01-01T00:00:00Z'),
			userId,
			...overrides,
		});
	const account = (userId, overrides = {}) =>
		insert('account', {
			id: `a${next()}`,
			accountId: userId,
			providerId: 'credential',
			userId,
			updatedAt: new Date('2026-01-01T00:00:00Z'),
			...overrides,
		});

	it('rejects a duplicate email, username, session token and (providerId, accountId)', async () => {
		const first = await user({ email: 'dup@example.invalid', username: 'dup_name' });
		await expect(user({ email: 'dup@example.invalid' })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
		await expect(user({ username: 'dup_name' })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

		await session(first.id, { token: 'fake-token-dup' });
		await expect(session(first.id, { token: 'fake-token-dup' })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });

		await account(first.id, { accountId: 'fake-account' });
		await expect(account(first.id, { accountId: 'fake-account' })).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
		// The same account id under another provider is a different identity.
		await account(first.id, { providerId: 'other', accountId: 'fake-account' });
	});

	it('deletes a user\'s sessions and accounts with the user, and only theirs', async () => {
		const gone = await user();
		const kept = await user();
		await session(gone.id);
		await account(gone.id);
		await session(kept.id);
		await account(kept.id);

		await db.query('DELETE FROM "user" WHERE id = $1', [gone.id]);

		expect(await count('session')).toBe(1);
		expect(await count('account')).toBe(1);
	});

	it('accepts both a migrated 24-hex id and a 32-character id', async () => {
		const migrated = await user({ id: 'a1b2c3d4e5f60718293a4b5c' });
		const fresh = await user({ id: 'Zx9Qw3Er5Ty7Ui1Op2As4Df6Gh8Jk0Lq' });
		expect(migrated.id).toHaveLength(24);
		expect(fresh.id).toHaveLength(32);
	});
});

describe('lib/prisma', () => {
	let lib;

	beforeAll(async () => {
		// A database whose default zone is +07 is what exposes an unpinned session.
		await db.query(`ALTER DATABASE ${db.escapeIdentifier(process.env.PG_TEST_DB)} SET timezone = 'Asia/Ho_Chi_Minh'`);
		lib = require('../../lib/prisma');
	});

	afterAll(async () => {
		await lib.closeDb();
		await db.query(`ALTER DATABASE ${db.escapeIdentifier(process.env.PG_TEST_DB)} RESET timezone`);
	});

	it('connects to this file\'s database', async () => {
		const [row] = await lib.prisma.$queryRaw`SELECT current_database() AS db`;
		expect(row.db).toBe(process.env.PG_TEST_DB);
	});

	it('pins its sessions to UTC even when the database default is another zone', async () => {
		const [row] = await lib.prisma.$queryRaw`SELECT extract(timezone from now())::int AS utc_offset`;
		expect(row.utc_offset).toBe(0);
	});

	it('stores a Date at the right instant, read back through SQL rather than the client', async () => {
		const at = new Date('2026-10-11T03:04:05.678Z');
		const created = await lib.prisma.product.create({
			data: { name: 'x', price: 1000, category: 'food', publicCode: 'PRISMA01', slug: 'x', saleStartDate: at },
		});
		expect(created.id).toMatch(HEX_ID);

		const { rows } = await db.query(
			`SELECT to_char(sale_start_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS iso FROM products WHERE id = $1`,
			[created.id]
		);
		expect(rows[0].iso).toBe(at.toISOString());
	});

	it('takes the next stock sequence value from the database', async () => {
		const a = await lib.prisma.stockMovement.create({
			data: { productId: 'a'.repeat(24), type: 'order', delta: -1, idempotencyKey: 'prisma-1' },
		});
		const b = await lib.prisma.stockMovement.create({
			data: { productId: 'a'.repeat(24), type: 'order', delta: -1, idempotencyKey: 'prisma-2' },
		});
		expect(b.seq).toBe(a.seq + 1);
	});
});
