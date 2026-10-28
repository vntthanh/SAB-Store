/**
 * Prisma and pg errors can quote the connection string they were given,
 * and the log leaves the database's access controls (it goes to the shared log
 * pipeline). A database error must reach the log with the host and without the
 * userinfo part of the URL, whatever characters the password holds.
 */
const ErrorLogger = require('../../utils/errorLogger');

function loggedText(spy) {
	return spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

// Every case has its own password, so an assertion about one cannot be satisfied by another.
// `tail` is the part after the character that ends a naive match; it must not leak either.
const PASSWORDS = [
	{ label: 'plain', password: 'pw-plain-9f3k2m-zz', tail: 'plain-9f3k2m-zz' },
	{ label: 'a raw "@" and "/"', password: 'pw@/raw-7d1x8q-yy', tail: 'raw-7d1x8q-yy' },
	{ label: 'a double quote', password: 'pw"dq-4h6j0c-xx', tail: 'dq-4h6j0c-xx' },
	{ label: 'a single quote', password: "pw'sq-8b2n5v-ww", tail: 'sq-8b2n5v-ww' },
	{ label: 'a backtick', password: 'pw`bt-3t7y1e-vv', tail: 'bt-3t7y1e-vv' },
];
const SCHEMES = [
	['PostgreSQL', 'postgresql', 'db.internal:5432/sabstore', 'DATABASE_URL'],
];

describe('ErrorLogger connection-string redaction', () => {
	let errorSpy;
	let savedEnv;
	beforeEach(() => {
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		savedEnv = { DATABASE_URL: process.env.DATABASE_URL };
	});
	afterEach(() => {
		errorSpy.mockRestore();
		for (const [name, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	function expectNoLeak(text, { password, tail }) {
		expect(text).not.toContain(password);
		expect(text).not.toContain(tail);
		expect(text).not.toContain(JSON.stringify(password).slice(1, -1));
	}

	describe.each(SCHEMES)('%s URL', (_, scheme, rest, envName) => {
		it.each(PASSWORDS)('logDatabase drops a password with $label from the message and the stack, and keeps the host', ({ password, tail }) => {
			const url = `${scheme}://sab:${password}@${rest}`;
			// The server's own configuration holds the same URL.
			process.env[envName] = url;
			const error = new Error(`Can't reach database server at ${url} (invalid input)`);
			error.stack = `Error: ${error.message}\n    at connect (${url})`;

			const info = ErrorLogger.logDatabase('connect', error, { step: 'connection' });

			const text = loggedText(errorSpy);
			expectNoLeak(text, { password, tail });
			expectNoLeak(JSON.stringify(info), { password, tail });
			expect(text).not.toContain('sab:');
			expect(text).toMatch(/\.internal/);
			expect(info.message).toContain('[redacted]');
		});
	});

	it.each(SCHEMES)('removes the userinfo of a %s URL even when the configuration does not hold it', (_, scheme, rest) => {
		delete process.env.DATABASE_URL;
		const { password, tail } = PASSWORDS[1];
		const error = new Error(`connect failed for ${scheme}://sab:${password}@${rest}`);

		const info = ErrorLogger.logDatabase('connect', error);

		expectNoLeak(loggedText(errorSpy), { password, tail });
		expect(info.message).toContain('[redacted]@');
	});

	it('removes the configured password in its percent-encoded form too', () => {
		const password = 'pw@/enc-2w9p4r-uu';
		process.env.DATABASE_URL = `postgresql://sab:${encodeURIComponent(password)}@db.internal:5432/sabstore`;
		const error = new Error(`password ${password} and ${encodeURIComponent(password)} rejected`);

		const info = ErrorLogger.logDatabase('connect', error);

		const text = loggedText(errorSpy);
		expectNoLeak(text, { password, tail: 'enc-2w9p4r-uu' });
		expect(text).not.toContain(encodeURIComponent(password));
		expect(info.message).toBe('password [redacted] and [redacted] rejected');
	});

	it('removes the configured password from free-form context', () => {
		const password = 'pw"ctx-6a0s3d-tt';
		process.env.DATABASE_URL = `postgresql://sab:${encodeURIComponent(password)}@db.internal:5432/sabstore`;

		ErrorLogger.logDatabase('query', new Error('boom'), { query: `SELECT '${password}'` });

		expectNoLeak(loggedText(errorSpy), { password, tail: 'ctx-6a0s3d-tt' });
	});

	it('logDatabase names the store it is running on', () => {
		const info = ErrorLogger.logDatabase('connect', new Error('boom'));
		expect(info.context.database).toBe('postgresql');
	});

	it('logCritical, used for a failed start, drops the userinfo as well', () => {
		const { password, tail } = PASSWORDS[0];
		const error = new Error(`connect failed for postgresql://sab:${password}@db.internal:5432/sabstore`);

		const info = ErrorLogger.logCritical('Startup failed', error, { stage: 'startup' });

		expectNoLeak(loggedText(errorSpy), { password, tail });
		expectNoLeak(JSON.stringify(info), { password, tail });
	});

	it('leaves a message without a connection string untouched', () => {
		const info = ErrorLogger.logDatabase('query', new Error('duplicate key value violates unique constraint "orders_order_code_key"'));
		expect(info.message).toBe('duplicate key value violates unique constraint "orders_order_code_key"');
	});

	describe('process-level handlers', () => {
		const { password, tail } = PASSWORDS[2];
		const url = `postgresql://sab:${password}@db.internal:5432/sabstore`;

		beforeEach(() => {
			process.env.DATABASE_URL = url;
		});

		it('logUncaughtException removes the password from the message and the stack', () => {
			const error = new Error(`connect failed for ${url}`);

			const info = ErrorLogger.logUncaughtException(error);

			expectNoLeak(loggedText(errorSpy), { password, tail });
			expectNoLeak(JSON.stringify(info), { password, tail });
		});

		it('logUncaughtException does not print properties the error carries beyond its message and stack', () => {
			// `new URL(bad)` throws a TypeError whose `input` holds the whole string.
			const error = Object.assign(new TypeError('Invalid URL'), { input: url, code: 'ERR_INVALID_URL' });

			const info = ErrorLogger.logUncaughtException(error);

			expect(loggedText(errorSpy)).not.toContain('db.internal');
			expect(info.error.code).toBe('ERR_INVALID_URL');
		});

		it('logUnhandledRejection removes the password from an Error reason', () => {
			const reason = new Error(`connect failed for ${url}`);

			const info = ErrorLogger.logUnhandledRejection(reason, Promise.resolve());

			expectNoLeak(loggedText(errorSpy), { password, tail });
			expectNoLeak(JSON.stringify(info), { password, tail });
		});

		it('logUnhandledRejection removes the password from a string reason', () => {
			const info = ErrorLogger.logUnhandledRejection(`rejected with ${url}`, Promise.resolve());

			expectNoLeak(loggedText(errorSpy), { password, tail });
			expectNoLeak(JSON.stringify(info), { password, tail });
		});

		it('logs a thrown value that is not an Error without printing it whole', () => {
			const info = ErrorLogger.logUncaughtException({ secretUrl: url });

			expect(loggedText(errorSpy)).not.toContain('db.internal');
			expect(info.error.message).toBe('Non-error value thrown');
		});
	});
});
