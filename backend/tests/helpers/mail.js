/**
 * Fixtures for the order-mail tests: a valid settings body and a stand-in for the
 * SMTP transport, so no test opens a socket.
 */
const nodemailer = require('nodemailer');

const MAIL_BODY = {
	enabled: true,
	host: 'smtp.test.example',
	port: 587,
	secure: false,
	username: 'mailer-user',
	pass: 'S3cret-smtp-pass',
	fromName: 'SAB Store',
	fromAddress: 'shop@test.example',
	notifyOrderCreated: true,
	notifyStatusChanged: true
};

/**
 * Replaces `nodemailer.createTransport` with a spy returning a transport whose
 * `sendMail` resolves. Restored by `vi.restoreAllMocks()`.
 */
function stubTransport({ sendMail = vi.fn().mockResolvedValue({ messageId: 'stub' }) } = {}) {
	const createTransport = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail, close: vi.fn() });
	return { createTransport, sendMail };
}

/**
 * Observes the fire-and-forget order mail without a fixed sleep. The routes queue the
 * mailer with setImmediate after answering, so a macrotask hop queued after the response
 * runs behind it; `findConfig` is the mailer's first read once it has an address.
 *
 * - `settled()`: the mailer has read the settings and every step that follows without
 *   further I/O (a skip decision) has run.
 * - `flushQueued()`: queued mailer calls have started; use it when the mailer returns
 *   before reading the database (no customer address) or was never called.
 */
function watchOrderMail() {
	const { mailSettings } = require('../../data');
	const read = vi.spyOn(mailSettings, 'findConfig');
	const flushQueued = () => new Promise((resolve) => setImmediate(resolve));
	const settled = async () => {
		await vi.waitFor(() => expect(read).toHaveBeenCalled());
		await Promise.allSettled(read.mock.results.map((result) => result.value));
		await flushQueued();
	};
	return { read, settled, flushQueued };
}

module.exports = { MAIL_BODY, stubTransport, watchOrderMail };
