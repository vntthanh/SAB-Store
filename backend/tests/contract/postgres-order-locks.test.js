/**
 * The order row lock, observed from a second connection. Skipped on the mongo
 * backend, which serialises racing writers of one order through write conflicts.
 */
const { Client } = require('pg');
const { POOL_OPTIONS } = require('../helpers/postgres');
const { insertRawProduct, insertRawOrder, findOrder, stockOf } = require('../helpers/db');

const POSTGRES = process.env.DATA_BACKEND === 'postgres';

/**
 * Resolves once another session of this database is blocked by the lock this
 * client holds on an order row, i.e. the operation under test reached it. The
 * blocker is matched by pid, not by query text: a pipelined session reports its
 * previous statement while it waits.
 */
async function waitForLockWait(client, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { rowCount } = await client.query(
			`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND pg_blocking_pids(pid) @> ARRAY[pg_backend_pid()]`
		);
		if (rowCount > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('no session was ever blocked by the order lock held by the test');
}

describe.skipIf(!POSTGRES)('postgres order row lock', () => {
	let other;
	let data;

	beforeAll(async () => {
		data = require('../../data');
		other = new Client({ connectionString: process.env.DATABASE_URL, options: POOL_OPTIONS });
		await other.connect();
		// Prisma loads its query compiler on first use; do that before a test times a lock wait.
		await data.orders.count();
	});

	afterEach(async () => {
		await other.query('ROLLBACK');
	});

	afterAll(async () => {
		await other.end();
		await require('../../lib/prisma').closeDb();
	});

	const holdLock = async (orderId) => {
		await other.query('BEGIN');
		await other.query('SELECT 1 FROM orders WHERE id = $1::uuid FOR NO KEY UPDATE', [orderId]);
	};

	it('makes a read inside a transaction wait for the writer of the order, then see what it committed', async () => {
		const order = await insertRawOrder({ status: 'confirmed' });
		await holdLock(order._id);
		await other.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1::uuid`, [order._id]);

		const reading = data.withTransaction((tx) => data.orders.findById(order._id, tx));
		await waitForLockWait(other);
		await other.query('COMMIT');

		expect((await reading).status).toBe('cancelled');
	});

	it('does not make a plain read wait', async () => {
		const order = await insertRawOrder({ status: 'confirmed' });
		await holdLock(order._id);

		expect((await data.orders.findById(order._id)).status).toBe('confirmed');
		expect((await data.orders.findDetail(order._id)).status).toBe('confirmed');
	});

	it('makes a note wait for the writer of the order instead of racing it for a position', async () => {
		const order = await insertRawOrder({});
		await holdLock(order._id);

		const writing = data.orders.updateNotes({ orderId: order._id, internalNote: { note: 'late', by: 'admin' } });
		await waitForLockWait(other);
		await other.query('COMMIT');
		await writing;

		expect((await findOrder(order._id)).internalNotes.map((entry) => entry.note)).toEqual(['late']);
	});

	it('does not hold up the stock applier, which locks movement then product and never an order', async () => {
		const product = await insertRawProduct({ stockQuantity: 0 });
		const order = await insertRawOrder({});
		const movement = await require('../../services/stock-ledger').recordMovement({ productId: product._id, type: 'adjust', delta: 4, orderId: order._id, idempotencyKey: 'order-lock-free' });
		await holdLock(order._id);

		expect((await require('../../services/stock-ledger').applyMovement(movement._id)).applied).toBe(true);
		expect(await stockOf(product._id)).toBe(4);
	});
});
