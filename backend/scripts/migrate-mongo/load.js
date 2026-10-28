/**
 * Loads a MongoDB store into an empty PostgreSQL database in one transaction,
 * and proves the result before it commits.
 *
 * Order: map and validate everything in memory (no database touched); then, in
 * one transaction: lock every target table, refuse a target that holds any row,
 * insert the auth rows, write the business data through the restore
 * (`dataSnapshot.replaceAll`), and check what was written:
 * - row counts per table, child tables included;
 * - every source field read back unchanged (`compare.js`), ids mapped;
 * - the stock caches against the ledger (`reconcile`), which must be clean: a
 *   source with drift is repaired in Mongo first, never by the migration;
 * - the password hashes, hashed as a set, equal to the source's;
 * - the `seq` sequence past every movement, so the next movement inserts.
 * A dry run does all of it and then rolls back. Any problem rolls back too.
 */
const { dataSnapshot, withTransaction } = require('../../data');
const { WHOLE_STORE_TX } = require('../../data/postgres/data-snapshot');
const { isDuplicateKeyError } = require('../../data/errors');
const { reconcile } = require('../../services/stock-ledger');
const { buildStoreSnapshot } = require('./store');
const { mapAuth, sha256 } = require('./auth');
const { compareStore } = require('./compare');
const { TARGET_TABLES, countTables } = require('./tables');

const AUTH_TABLES = ['user', 'account', 'session', 'verification', 'jwks'];

/** Thrown to end the transaction without committing; carries the result out. */
class Rollback extends Error {
	constructor(result) {
		super('rolled back');
		this.result = result;
	}
}

/** What each table must hold once `store` and `auth` are written. */
function expectedCounts(store, auth) {
	const { products, combos, orders, stockMovements, settings } = store.data;
	const childCount = (rows, key) => rows.reduce((sum, row) => sum + (Array.isArray(row[key]) ? row[key].length : 0), 0);
	return {
		...Object.fromEntries(AUTH_TABLES.map((table) => [table, auth.rows[table].length])),
		products: products.length,
		combos: combos.length,
		combo_category_requirements: childCount(combos, 'categoryRequirements'),
		orders: orders.length,
		order_items: childCount(orders, 'items'),
		order_status_history: childCount(orders, 'statusHistory'),
		order_internal_notes: childCount(orders, 'internalNotes'),
		order_items_edits: childCount(orders, 'itemsHistory'),
		stock_movements: stockMovements.length,
		settings: settings.length
	};
}

/**
 * Sequences are not transactional: a rolled-back run (a dry run included)
 * leaves `seq` advanced, which is a gap, never a collision. So the check is
 * "past the largest seq", not "equal to it".
 */
async function sequencePastMax(tx) {
	const [{ max, last }] = await tx.$queryRaw`
		SELECT (SELECT max(seq) FROM stock_movements)::int AS max,
			pg_sequence_last_value(pg_get_serial_sequence('stock_movements', 'seq')::regclass)::int AS last`;
	return max === null || (last !== null && last >= max);
}

/**
 * The auth rows, inserted table by table. A refused insert is reported by table
 * and error code only: Prisma's own message repeats the row, which holds emails,
 * hashes and tokens.
 */
async function insertAuth(tx, rows) {
	for (const table of AUTH_TABLES) {
		if (rows[table].length === 0) continue;
		try {
			await tx[table].createMany({ data: rows[table] });
		} catch (err) {
			throw new Error(`Ghi bảng ${table} thất bại (${err.code ?? err.name})`);
		}
	}
}

const sum = (rows, key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);

function sourceTotals(data) {
	return {
		orderTotalAmount: sum(data.orders, 'totalAmount'),
		// Not `sum(data.products, '<field>')`: the stock-cache write scan reads a quoted field name as a write.
		productStock: data.products.reduce((total, product) => total + (Number(product.stockQuantity) || 0), 0),
		appliedDelta: sum(data.stockMovements.filter((m) => m.status === 'applied'), 'delta')
	};
}

async function targetTotals(tx) {
	const [{ orders, stock, delta }] = await tx.$queryRaw`
		SELECT (SELECT coalesce(sum(total_amount), 0) FROM orders)::int AS orders,
			(SELECT coalesce(sum(stock_quantity), 0) FROM products)::int AS stock,
			(SELECT coalesce(sum(delta), 0) FROM stock_movements WHERE status = 'applied')::int AS delta`;
	return { orderTotalAmount: orders, productStock: stock, appliedDelta: delta };
}

async function writeAndVerify(tx, store, auth) {
	// Locked before the emptiness check, so a backend booting against the same
	// database cannot seed a row between the check and the writes.
	await tx.$executeRawUnsafe(`LOCK TABLE ${TARGET_TABLES.map((table) => `"${table}"`).join(', ')} IN ACCESS EXCLUSIVE MODE`);
	const before = await countTables(tx);
	const occupied = TARGET_TABLES.filter((table) => before[table] > 0);
	if (occupied.length > 0) {
		return { problems: [`Database đích không trống (${occupied.join(', ')}): chỉ nạp vào database mới tạo`], report: {} };
	}

	await insertAuth(tx, auth.rows);
	let written;
	try {
		written = await dataSnapshot.replaceAll(store.data, tx);
	} catch (err) {
		if (!isDuplicateKeyError(err)) throw err;
		return { problems: [`Giá trị trùng ở cột unique: ${err.fields.join(', ')}`], report: {} };
	}

	const problems = [];
	const counts = await countTables(tx);
	const expected = expectedCounts(store, auth);
	for (const table of TARGET_TABLES) {
		if (counts[table] !== expected[table]) problems.push(`Bảng ${table}: ${counts[table]} dòng, cần ${expected[table]}`);
	}

	problems.push(...compareStore(store.data, await dataSnapshot.exportAll(tx)));

	for (const { productId, variantId, cached, ledgerSum } of await reconcile({ tx })) {
		problems.push(`${variantId ? `Phân loại ${variantId} của sản phẩm` : 'Sản phẩm'} ${productId}: tồn kho ${cached}, lịch sử nhập xuất cho ${ledgerSum}`);
	}

	const hashes = await tx.account.findMany({ where: { password: { not: null } }, select: { password: true } });
	if (sha256(hashes.map((row) => row.password)) !== auth.passwordDigest) problems.push('Mật khẩu (hash) đọc lại khác nguồn');

	if (!(await sequencePastMax(tx))) problems.push('Sequence của stock_movements.seq chưa vượt qua seq lớn nhất');

	return {
		problems,
		report: {
			written,
			counts,
			totals: { source: sourceTotals(store.data), target: await targetTotals(tx) },
			pendingMovements: store.data.stockMovements.filter((m) => m.status === 'pending').length
		}
	};
}

/**
 * @param {{store: Record<string, object[]>, auth: Record<string, object[]>, others: Record<string, number>}} source readSource()
 * @param {{apply?: boolean, now?: Date}} [options] without `apply` nothing is committed
 * @returns {Promise<{ok: boolean, committed: boolean, problems: string[], report: object}>}
 */
async function migrate(source, { apply = false, now = new Date() } = {}) {
	const store = buildStoreSnapshot(source.store, now);
	const auth = mapAuth(source.auth, now);
	const leftBehind = Object.entries(source.others).filter(([, n]) => n > 0)
		.map(([name, n]) => `Collection "${name}" (${n} bản ghi) không được chuyển: xử lý trước khi nạp`);
	const report = { mode: apply ? 'apply' : 'dry-run', repairs: store.repairs, auth: auth.report };

	const problems = [...leftBehind, ...store.problems, ...auth.problems];
	if (problems.length > 0) return { ok: false, committed: false, problems, report };

	let outcome;
	try {
		outcome = await withTransaction(async (tx) => {
			const result = await writeAndVerify(tx, store, auth);
			if (result.problems.length > 0 || !apply) throw new Rollback(result);
			return result;
		}, WHOLE_STORE_TX);
	} catch (err) {
		if (!(err instanceof Rollback)) throw err;
		const { problems: found, report: verified } = err.result;
		return { ok: found.length === 0, committed: false, problems: found, report: { ...report, ...verified } };
	}
	return { ok: true, committed: true, problems: [], report: { ...report, ...outcome.report } };
}

module.exports = { migrate };
