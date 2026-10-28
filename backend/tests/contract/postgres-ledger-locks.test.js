/**
 * The row locks the postgres ledger relies on, observed from a second
 * connection. Skipped on the mongo backend, which serialises through write
 * conflicts instead.
 */
const { Client } = require('pg');
const { POOL_OPTIONS } = require('../helpers/postgres');
const { insertRawProduct, findMovement, stockOf } = require('../helpers/db');

const POSTGRES = process.env.DATA_BACKEND === 'postgres';

/**
 * Resolves once some other backend of this database is waiting for a lock, i.e.
 * the operation under test has reached the lock the test holds. Polling the
 * server beats sleeping for a fixed time: it neither passes early on a slow
 * machine nor waits longer than needed.
 */
async function waitForLockWait(client, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { rowCount } = await client.query(
			`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`
		);
		if (rowCount > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('no session ever waited for a lock');
}

const isPending = async (promise) => {
	const marker = Symbol('pending');
	return (await Promise.race([promise.then(() => null, () => null), Promise.resolve(marker)])) === marker;
};

describe.skipIf(!POSTGRES)('postgres stock-ledger locks', () => {
	let other;
	let ledger;
	let stockLedger;

	beforeAll(async () => {
		ledger = require('../../services/stock-ledger');
		({ stockLedger } = require('../../data'));
		other = new Client({ connectionString: process.env.DATABASE_URL, options: POOL_OPTIONS });
		await other.connect();
	});

	afterEach(async () => {
		await other.query('ROLLBACK');
	});

	afterAll(async () => {
		await other.end();
		await require('../../lib/prisma').closeDb();
	});

	it('makes an apply wait for a writer holding the variant row, then read the stock that writer committed', async () => {
		const product = await insertRawProduct({ stockQuantity: 10 });
		const target = await ledger.recordMovement({ productId: product._id, type: 'set_target', target: 3, idempotencyKey: 'lock-target' });

		await other.query('BEGIN');
		await other.query('SELECT 1 FROM product_variants WHERE product_id = $1::uuid FOR NO KEY UPDATE', [product._id]);
		await other.query('UPDATE product_variants SET stock_quantity = 20 WHERE product_id = $1::uuid', [product._id]);
		await other.query('UPDATE products SET stock_quantity = 20 WHERE id = $1::uuid', [product._id]);
		const applying = ledger.applyMovement(target._id);

		await waitForLockWait(other);
		expect(await isPending(applying)).toBe(true);
		await other.query('COMMIT');
		expect((await applying).applied).toBe(true);

		expect(await stockOf(product._id)).toBe(3);
		expect(await findMovement(target._id)).toMatchObject({ delta: -17, stockAfter: 3 });
	});

	it('serialises two appliers of one product: the second waits for the first to commit', async () => {
		const product = await insertRawProduct({ stockQuantity: 0 });
		const first = await ledger.recordMovement({ productId: product._id, type: 'adjust', delta: 1, idempotencyKey: 'lock-first' });
		const second = await ledger.recordMovement({ productId: product._id, type: 'adjust', delta: 2, idempotencyKey: 'lock-second' });
		await ledger.applyMovement(first._id);

		// Another session is in the middle of an apply: it holds the product lock an applier takes.
		await other.query('BEGIN');
		await other.query('SELECT 1 FROM products WHERE id = $1::uuid FOR NO KEY UPDATE', [product._id]);
		const applying = stockLedger.applyClaimed(second._id);

		await waitForLockWait(other);
		expect(await isPending(applying)).toBe(true);
		await other.query('COMMIT');
		expect(await applying).toBe(true);
		expect(await stockOf(product._id)).toBe(3);
	});

	it('reads an opening baseline only after a running apply on that product has committed', async () => {
		const product = await insertRawProduct({ stockQuantity: 0 });
		const prisma = require('../../lib/prisma').prisma;

		await other.query('BEGIN');
		await other.query('SELECT 1 FROM products WHERE id = $1::uuid FOR NO KEY UPDATE', [product._id]);
		await other.query('UPDATE products SET stock_quantity = 7 WHERE id = $1::uuid', [product._id]);
		const reading = prisma.$transaction((tx) => stockLedger.readOpeningBasis(product._id, tx));

		await waitForLockWait(other);
		expect(await isPending(reading)).toBe(true);
		await other.query('COMMIT');

		expect(await reading).toEqual({ stockQuantity: 7, appliedSum: 0 });
	});

	it('does not let a second run of a movement finish before the first run commits', async () => {
		const product = await insertRawProduct({ stockQuantity: 0 });
		const movement = await ledger.recordMovement({ productId: product._id, type: 'adjust', delta: 4, idempotencyKey: 'lock-movement' });

		await other.query('BEGIN');
		await other.query('SELECT 1 FROM stock_movements WHERE id = $1::uuid FOR UPDATE', [movement._id]);
		const applying = stockLedger.applyClaimed(movement._id);

		await waitForLockWait(other);
		expect(await isPending(applying)).toBe(true);
		await other.query(`UPDATE stock_movements SET status = 'applied', applied_at = now(), stock_after = 4 WHERE id = $1::uuid`, [movement._id]);
		await other.query('COMMIT');

		expect(await applying).toBe(false);
		expect(await stockOf(product._id)).toBe(0);
	});
});
