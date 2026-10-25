/**
 * Order mail over the SMTP account an admin saved on the Settings page.
 *
 * Mail is off until the admin turns it on: with no row, the master switch off, a
 * password that no longer decrypts, the kind's own switch off, or no recipient
 * address, `sendOrderMail` and `sendMail` return 'skipped' without building a transport, so no
 * connection is ever attempted. Sending is best effort and never throws to the
 * caller: an order or status change has already committed when it runs.
 *
 * The password is only ever held in memory here. Logs carry none of the password,
 * the SMTP username, an address or the mail content. The one thing that does reach
 * a client is `sendTest`'s error: the server's own reply with the username and
 * password removed, which may still quote an address.
 */
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { mailSettings, settings } = require('../data');
const { encryptSecret, decryptSecret } = require('../lib/secret-box');
const { renderOrderMail } = require('./mail-templates');

// nodemailer's defaults (2 minutes to connect, 10 idle) would hold an admin request
// or a background send for minutes against a dead host.
const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;
const DNS_TIMEOUT_MS = 15_000;

const ERROR_TEXT_MAX_LENGTH = 200;
const TEST_LIMIT = 5;
const TEST_WINDOW_MS = 10 * 60 * 1000;

const KIND_SWITCH = {
	order_created: 'notifyOrderCreated',
	status_changed: 'notifyStatusChanged'
};

/** An error whose message is safe to show the admin, with the HTTP status to answer. */
class MailServiceError extends Error {
	constructor(status, message) {
		super(message);
		this.name = 'MailServiceError';
		this.status = status;
	}
}

const PUBLIC_FIELDS = [
	'enabled', 'host', 'port', 'secure', 'username', 'fromName', 'fromAddress',
	'notifyOrderCreated', 'notifyStatusChanged', 'updatedAt', 'updatedBy'
];

function toPublic(row) {
	return {
		...Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, row[field]])),
		hasPassword: decryptSecret(row.passEncrypted) !== null
	};
}

/** The saved account with the password decrypted, or null when mail is not set up (or the key changed). */
async function loadAccount() {
	const row = await mailSettings.findConfig();
	if (!row) return null;
	const pass = decryptSecret(row.passEncrypted);
	return pass === null ? null : { row, pass };
}

async function getPublicConfig() {
	const row = await mailSettings.findConfig();
	return row ? toPublic(row) : null;
}

/**
 * Saves the account. `body` is already validated; fields are picked one by one.
 * Without `pass` the stored password stays, which needs a row whose password still decrypts.
 *
 * @throws {MailServiceError} 400 when there is no password to keep
 */
async function saveConfig(body, actor) {
	const fields = {
		enabled: body.enabled,
		host: body.host.trim(),
		port: Number(body.port),
		secure: body.secure,
		username: body.username.trim(),
		fromName: body.fromName.trim(),
		fromAddress: body.fromAddress.trim(),
		notifyOrderCreated: body.notifyOrderCreated,
		notifyStatusChanged: body.notifyStatusChanged,
		updatedBy: actor
	};

	if (typeof body.pass === 'string' && body.pass !== '') {
		fields.passEncrypted = encryptSecret(body.pass);
	} else if (!(await loadAccount())) {
		throw new MailServiceError(400, 'Vui lòng nhập mật khẩu SMTP');
	}

	return toPublic(await mailSettings.upsertConfig(fields));
}

let cached = null;

function fingerprint({ row, pass }) {
	return crypto
		.createHash('sha256')
		.update(JSON.stringify([row.host, row.port, row.secure, row.username, pass, row.fromName, row.fromAddress]))
		.digest('hex');
}

function createTransport({ row, pass }) {
	return nodemailer.createTransport({
		host: row.host,
		port: row.port,
		secure: row.secure,
		// Without implicit TLS, refuse a server that does not offer STARTTLS: the
		// AUTH exchange would otherwise carry the password in clear text.
		requireTLS: !row.secure,
		auth: { user: row.username, pass },
		connectionTimeout: CONNECTION_TIMEOUT_MS,
		greetingTimeout: GREETING_TIMEOUT_MS,
		socketTimeout: SOCKET_TIMEOUT_MS,
		dnsTimeout: DNS_TIMEOUT_MS
	});
}

function sharedTransport(account) {
	const key = fingerprint(account);
	if (cached?.key !== key) cached = { key, transport: createTransport(account) };
	return cached.transport;
}

const senderOf = ({ row }) => ({ name: row.fromName, address: row.fromAddress });

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The admin-visible text of a send failure: SMTP code, response code and the
 * server's response, with the username and password removed in every form they
 * take on the wire (as typed, base64, and the AUTH PLAIN envelope), then capped.
 * Redaction runs before the cap so a secret is never cut in half and left behind.
 *
 * @param {unknown} err
 * @param {string} username
 * @param {string} pass
 */
function sanitizeMailError(err, username, pass) {
	const source = err !== null && typeof err === 'object' ? err : {};
	const head = [
		typeof source.code === 'string' ? source.code : '',
		typeof source.responseCode === 'number' ? String(source.responseCode) : ''
	].filter(Boolean).join(' ');
	let response = typeof source.response === 'string' ? source.response : '';

	const secrets = [username, pass].filter(Boolean);
	// Base64 is case-sensitive and removed first: a case-insensitive plain match can sit
	// inside a base64 token, and cutting it there would break the token for the exact match.
	// The AUTH PLAIN form goes first because it contains the bytes of both others.
	const encoded = [
		Buffer.from(`\0${username}\0${pass}`, 'utf8').toString('base64'),
		...secrets.map((secret) => Buffer.from(secret, 'utf8').toString('base64'))
	];
	for (const secret of encoded) response = response.split(secret).join('[redacted]');
	for (const secret of secrets) response = response.replace(new RegExp(escapeRegExp(secret), 'gi'), '[redacted]');

	const text = head && response ? `${head}: ${response}` : head || response || 'Gửi mail thất bại';
	return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

// Per admin: 5 test sends in any 10 minutes. In memory, so it resets on restart and is
// per process, which is enough to stop an admin session from being used as a mail cannon.
// Hand-rolled rather than express-rate-limit: the global limiters are off by default and
// keyed by IP, while this one must always apply and count per admin.
const testSends = new Map();

function takeTestSlot(key, now = Date.now()) {
	const recent = (testSends.get(key) || []).filter((at) => now - at < TEST_WINDOW_MS);
	if (recent.length >= TEST_LIMIT) {
		testSends.set(key, recent);
		return false;
	}
	recent.push(now);
	testSends.set(key, recent);
	return true;
}

/**
 * Sends one test mail through the SAVED account (never client-supplied connection
 * details, which would let a request aim the stored password at another server),
 * on a fresh transport so the connection is proven from scratch. Works while the
 * master switch is off.
 *
 * @throws {MailServiceError} 400 when not configured, 502 when the send failed
 */
async function sendTest(to) {
	const account = await loadAccount();
	if (!account) throw new MailServiceError(400, 'Chưa cấu hình SMTP hoặc cần nhập lại mật khẩu');

	const transport = createTransport(account);
	try {
		await transport.sendMail({
			from: senderOf(account),
			to,
			subject: 'Thư thử cấu hình SMTP',
			text: 'Đây là thư thử từ trang cài đặt SMTP. Nếu bạn nhận được thư này, cấu hình đã hoạt động.'
		});
	} catch (err) {
		console.error(`SMTP test mail failed: ${errorClass(err)}`);
		throw new MailServiceError(502, sanitizeMailError(err, account.row.username, account.pass));
	} finally {
		transport.close?.();
	}
}

function errorClass(err) {
	const name = typeof err?.name === 'string' ? err.name : 'Error';
	return typeof err?.code === 'string' ? `${name} ${err.code}` : name;
}

async function storeTitleOrDefault() {
	try {
		return (await settings.findStorefront())?.storeTitle;
	} catch {
		return undefined;
	}
}

let warnedUndecryptable = false;

/**
 * The one send path: reads the saved account, skips (no transport, no connection) unless
 * mail is on and, when `switchName` is given, that kind's own switch is on, then builds
 * and sends the message. Never rejects.
 */
async function sendWhenEnabled(switchName, label, buildMessage) {
	try {
		const row = await mailSettings.findConfig();
		if (!row || !row.enabled || (switchName && !row[switchName])) return 'skipped';
		const pass = decryptSecret(row.passEncrypted);
		if (pass === null) {
			// Switched on but sealed under an earlier JWT_SECRET: say so once, not per mail.
			if (!warnedUndecryptable) console.warn('Mail is on but the SMTP password no longer decrypts; re-enter it in Settings');
			warnedUndecryptable = true;
			return 'skipped';
		}
		const account = { row, pass };

		const message = await buildMessage();
		await sharedTransport(account).sendMail({ from: senderOf(account), ...message });
		return 'sent';
	} catch (err) {
		console.error(`${label} failed: ${errorClass(err)}`);
		return 'failed';
	}
}

/**
 * Best-effort mail for anything that is not an order notification (such as a sign-in
 * code). Behind the master switch only; the order kind switches do not apply.
 *
 * @param {{to: string, subject: string, html?: string, text?: string}} message
 * @returns {Promise<'sent'|'skipped'|'failed'>} never rejects
 */
async function sendMail({ to, subject, html, text }) {
	const address = typeof to === 'string' ? to.trim() : '';
	if (!address) return 'skipped';
	return sendWhenEnabled(null, 'Mail', async () => ({ to: address, subject, html, text }));
}

/**
 * Call after the change has committed. `order` carries `email`, `fullName`, `orderCode`,
 * `items`, `totalAmount`, `status`, `cancelReason`, plus `studentId`, `phoneNumber`,
 * `additionalNote`, `createdAt` and `paymentDescription` for a new order.
 *
 * @param {'order_created'|'status_changed'} kind
 * @returns {Promise<'sent'|'skipped'|'failed'>} never rejects
 */
async function sendOrderMail(kind, order) {
	const switchName = KIND_SWITCH[kind];
	const to = typeof order?.email === 'string' ? order.email.trim() : '';
	if (!switchName || !to) return 'skipped';

	return sendWhenEnabled(switchName, `Order mail (${kind})`, async () => {
		const { subject, html, text } = renderOrderMail(kind, order, await storeTitleOrDefault());
		return { to, subject, html, text };
	});
}

module.exports = { MailServiceError, getPublicConfig, saveConfig, sendTest, sendMail, sendOrderMail, takeTestSlot, sanitizeMailError };
