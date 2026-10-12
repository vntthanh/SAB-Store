const { waitForDatabase } = require('../../lib/wait-for-database');
const { MigrationsNotAppliedError } = require('../../lib/require-migrations');

describe('waitForDatabase', () => {
	let logSpy;
	beforeEach(() => {
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});
	afterEach(() => logSpy.mockRestore());

	it('retries while migrations are pending or running, then resolves once they are applied', async () => {
		const connect = vi.fn()
			.mockRejectedValueOnce(new MigrationsNotAppliedError('Migration(s) not applied: 002_add_column.'))
			.mockRejectedValueOnce(new MigrationsNotAppliedError('Migration(s) started but not finished: 002_add_column.'))
			.mockResolvedValueOnce(undefined);

		await expect(waitForDatabase({ connect, maxRetries: 5, delayMs: 0 })).resolves.toBe(true);
		expect(connect).toHaveBeenCalledTimes(3);
	});

	it('names the migrations in the final error when the window runs out', async () => {
		const connect = vi.fn().mockRejectedValue(new MigrationsNotAppliedError('Migration(s) not applied: 002_add_column.'));

		await expect(waitForDatabase({ connect, maxRetries: 3, delayMs: 0 }))
			.rejects.toThrow(/within timeout: Migration\(s\) not applied: 002_add_column/);
		expect(connect).toHaveBeenCalledTimes(3);
	});

	it('does not sleep after the last attempt', async () => {
		const connect = vi.fn().mockRejectedValue(new Error('refused'));
		const timer = vi.spyOn(globalThis, 'setTimeout');

		await expect(waitForDatabase({ connect, maxRetries: 2, delayMs: 0 })).rejects.toThrow(/refused/);
		expect(timer).toHaveBeenCalledTimes(1);
		timer.mockRestore();
	});
});
