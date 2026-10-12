/**
 * The postgres transaction wrapper: rollback, the single retry class and its
 * limit, and the log line a retry leaves. Skipped on the mongo backend.
 */
const { v7: uuidv7 } = require('uuid');

const POSTGRES = process.env.DATA_BACKEND === 'postgres';

describe.skipIf(!POSTGRES)('postgres withTransaction', () => {
	let prisma;
	let withTransaction;

	beforeAll(() => {
		({ prisma } = require('../../lib/prisma'));
		({ withTransaction } = require('../../data'));
	});

	afterAll(async () => {
		await prisma.$disconnect();
	});

	const deadlock = () => Object.assign(new Error('deadlock detected'), { code: 'P2034' });
	const movementCount = () => prisma.stockMovement.count();
	const insert = (tx) => tx.stockMovement.create({ data: { id: uuidv7(), productId: uuidv7(), type: 'adjust', delta: 1, idempotencyKey: uuidv7() } });

	it('commits what the callback wrote and returns its result', async () => {
		const result = await withTransaction(async (tx) => {
			await insert(tx);
			return 'done';
		});

		expect(result).toBe('done');
		expect(await movementCount()).toBe(1);
	});

	it('rolls everything back when the callback throws and rethrows the same error', async () => {
		const failure = new Error('order failed halfway');

		await expect(withTransaction(async (tx) => {
			await insert(tx);
			throw failure;
		})).rejects.toBe(failure);

		expect(await movementCount()).toBe(0);
	});

	it('re-runs the callback from the top after a deadlock, logging each retry', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		let runs = 0;

		try {
			const result = await withTransaction(async (tx) => {
				runs += 1;
				await insert(tx);
				if (runs < 3) throw deadlock();
				return runs;
			});

			expect(result).toBe(3);
			const retries = log.mock.calls.map(([line]) => JSON.parse(line)).filter((entry) => entry.event === 'db.tx.retry');
			expect(retries.map((entry) => entry.attempt)).toEqual([1, 2]);
		} finally {
			log.mockRestore();
		}
		expect(await movementCount()).toBe(1);
	});

	it('gives up after three attempts and surfaces the deadlock', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		let runs = 0;

		try {
			await expect(withTransaction(async () => {
				runs += 1;
				throw deadlock();
			})).rejects.toMatchObject({ code: 'P2034' });
		} finally {
			log.mockRestore();
		}
		expect(runs).toBe(3);
	});

	it('recovers from a real deadlock raised by a raw lock query: the loser re-runs', async () => {
		const a = uuidv7();
		const b = uuidv7();
		for (const id of [a, b]) {
			await prisma.product.create({ data: { id, name: id, price: 1, category: 'c', publicCode: id, slug: id } });
		}
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const lock = (tx, id) => tx.$queryRaw`SELECT 1 FROM products WHERE id = ${id}::uuid FOR UPDATE`;

		// Each run takes its first lock, waits until the other has too, then asks for the
		// other's lock. A re-run (after the deadlock victim rolled back) skips the barrier.
		let firstLocks = 0;
		let release;
		const bothHoldFirst = new Promise((resolve) => { release = resolve; });
		const run = (first, second) => withTransaction(async (tx) => {
			await lock(tx, first);
			firstLocks += 1;
			if (firstLocks === 2) release();
			await bothHoldFirst;
			await lock(tx, second);
			return first;
		});

		try {
			const results = await Promise.all([run(a, b), run(b, a)]);

			expect(results.sort()).toEqual([a, b].sort());
			const retries = log.mock.calls.map(([line]) => JSON.parse(line)).filter((entry) => entry.event === 'db.tx.retry');
			expect(retries).toHaveLength(1);
		} finally {
			log.mockRestore();
		}
	});

	it('does not retry any other error', async () => {
		let runs = 0;

		await expect(withTransaction(async () => {
			runs += 1;
			throw Object.assign(new Error('unique'), { code: 'P2002' });
		})).rejects.toMatchObject({ code: 'P2002' });

		expect(runs).toBe(1);
	});

	it('uses Read Committed', async () => {
		const [row] = await withTransaction((tx) => tx.$queryRaw`SELECT current_setting('transaction_isolation') AS level`);

		expect(row.level).toBe('read committed');
	});
});
