/**
 * Rules around the customer sign-in paths (email code, Google One Tap) and the
 * accounts they create. Kept apart from lib/auth.js so the configuration there stays
 * readable and each rule can be read, and tested, on its own.
 *
 * Everything here runs inside Better Auth hooks, after the HTTP router's own
 * `disabledPaths` and rate-limit gates and before the plugin endpoint handlers.
 */
const crypto = require('node:crypto');
const { APIError, getSessionFromCtx } = require('better-auth/api');
const { isValidEmail } = require('@sab/shared');
const { ERROR_CODES, ERROR_MESSAGES } = require('../constants/errorCodes');
// Reached as a module object (`mailer.sendMail`) so tests can spy on the mail edge.
const mailer = require('../services/mailer');

const OTP_EXPIRES_IN_SECONDS = 300;
const OTP_COOLDOWN_SECONDS = 60;
// Mail abuse caps, on top of the cooldown and the per-client limiter: those two are
// bypassed by rotating addresses (one victim mailbox, many sources) or sources (many
// victims), so the totals are bounded as well. Both numbers are deliberate: a targeted
// lock-out of one address (10 a day) or of the whole shop (300 an hour) is accepted
// because Google One Tap, and the password for staff, stay available as fallbacks.
const OTP_DAILY_CAP_PER_EMAIL = 10;
const OTP_HOURLY_CAP_GLOBAL = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// The plugin's own allowedAttempts (lib/auth.js); the unverified-account path below counts against the same budget.
const OTP_ALLOWED_ATTEMPTS = 5;

const OTP_SEND_PATH = '/email-otp/send-verification-otp';
const OTP_SIGN_IN_PATH = '/sign-in/email-otp';
const ONE_TAP_PATH = '/one-tap/callback';
const ADMIN_CREATE_USER_PATH = '/admin/create-user';
const ADMIN_UPDATE_USER_PATH = '/admin/update-user';

const STAFF_ROLES = ['admin', 'seller'];
const CUSTOMER_ROLE = 'customer';

const USERNAME_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const USERNAME_LENGTH = 12;
const USERNAME_ATTEMPTS = 5;
const NAME_MAX_LENGTH = 100;

const apiError = (status, code) => new APIError(status, { code, message: ERROR_MESSAGES[code].vi });

/** Roles are stored as a comma list; a staff role anywhere in it makes the account staff. */
function isStaffRole(role) {
	return typeof role === 'string' && role.split(',').some((part) => STAFF_ROLES.includes(part.trim()));
}

/** True when the comma list of roles contains `wanted`. */
const hasRole = (role, wanted) => typeof role === 'string' && role.split(',').some((part) => part.trim() === wanted);

const cooldownIdentifier = (email) => `otp-cooldown:${email}`;
const sentIdentifier = (email) => `otp-sent:${email}`;
const GLOBAL_SENT_IDENTIFIER = 'otp-sent:*';

// All three kinds of row live in the verification table under their own identifiers,
// never in the code's row: a wrong guess makes Better Auth recreate the code row, so a
// clock read from it could be restarted by anyone who knows the victim's address.
const liveRows = (identifier) => [
	{ field: 'identifier', value: identifier },
	{ field: 'expiresAt', operator: 'gt', value: new Date() }
];

const isCoolingDown = async (ctx, email) => (await ctx.context.adapter.count({ model: 'verification', where: liveRows(cooldownIdentifier(email)) })) > 0;

/** Throws when this address or the whole shop has used up its sends. Logs the counts only, never an address. */
async function assertUnderSendCaps(ctx, email) {
	const { adapter } = ctx.context;
	const [perEmail, global] = await Promise.all([
		adapter.count({ model: 'verification', where: liveRows(sentIdentifier(email)) }),
		adapter.count({ model: 'verification', where: liveRows(GLOBAL_SENT_IDENTIFIER) })
	]);
	if (perEmail >= OTP_DAILY_CAP_PER_EMAIL || global >= OTP_HOURLY_CAP_GLOBAL) {
		console.warn(`Sign-in code limit reached (${perEmail >= OTP_DAILY_CAP_PER_EMAIL ? 'address' : 'global'}): ${perEmail} to this address in 24h, ${global} in total in 1h`);
		throw apiError('TOO_MANY_REQUESTS', ERROR_CODES.OTP_LIMIT_REACHED);
	}
}

/**
 * Takes the cooldown before the mail goes out, so two concurrent requests cannot both
 * send. Neither store has a unique key on the identifier, so both requests write a row
 * with their own token and the oldest live row wins; the loser removes its row.
 */
async function claimCooldown(ctx, email) {
	const { adapter, internalAdapter } = ctx.context;
	const identifier = cooldownIdentifier(email);
	const token = crypto.randomUUID();
	const mine = await internalAdapter.createVerificationValue({
		identifier,
		value: token,
		expiresAt: new Date(Date.now() + OTP_COOLDOWN_SECONDS * 1000)
	});
	const [oldest] = await adapter.findMany({
		model: 'verification',
		where: liveRows(identifier),
		sortBy: { field: 'createdAt', direction: 'asc' },
		limit: 1
	});
	if (oldest?.value === token) return;
	await adapter.delete({ model: 'verification', where: [{ field: 'id', value: mine.id }] });
	throw apiError('TOO_MANY_REQUESTS', ERROR_CODES.OTP_COOLDOWN);
}

/** Counts one accepted send against the caps and drops this address's and the shop's expired rows (nothing else reads them). */
async function recordSend(ctx, email) {
	const { adapter, internalAdapter } = ctx.context;
	const now = Date.now();
	await adapter.deleteMany({
		model: 'verification',
		where: [
			{ field: 'identifier', operator: 'in', value: [cooldownIdentifier(email), sentIdentifier(email), GLOBAL_SENT_IDENTIFIER] },
			{ field: 'expiresAt', operator: 'lt', value: new Date(now) }
		]
	});
	await internalAdapter.createVerificationValue({ identifier: sentIdentifier(email), value: '1', expiresAt: new Date(now + DAY_MS) });
	await internalAdapter.createVerificationValue({ identifier: GLOBAL_SENT_IDENTIFIER, value: '1', expiresAt: new Date(now + HOUR_MS) });
}

// Mail jobs still running. The request never waits for them (see sendSignInCode);
// tests wait for them through settleSignInSends.
const pendingSends = new Set();

async function deliverSignInCode({ email, otp }, ctx) {
	let result;
	try {
		const message = await mailer.buildOtpMessage(email, otp, OTP_EXPIRES_IN_SECONDS / 60);
		result = await mailer.sendMail(message);
	} catch (error) {
		result = 'failed';
		console.error(`Sign-in code mail threw: ${error.message}`);
	}
	if (result !== 'sent') {
		console.error(`Sign-in code mail was not sent (${result})`);
		await ctx.context.internalAdapter.deleteVerificationByIdentifier(cooldownIdentifier(email));
		return;
	}
	// A failed send is not counted: a mail outage must not use up the caps.
	await recordSend(ctx, email);
}

/**
 * The `sendVerificationOTP` callback of the emailOTP plugin. Better Auth swallows an
 * error thrown here (it logs it and answers success), so every refusal is given
 * earlier, by the hook; this only sends, counts the send against the caps once the mail
 * was accepted, and gives the cooldown back when it was not so the customer can retry
 * at once. The code is never logged.
 *
 * The mail goes out in the background: the SMTP round trip would otherwise make a
 * normal send measurably slower than the unverified-account answer, which sends nothing,
 * and tell a caller which addresses hold such an account. The cooldown is already taken
 * by the hook, so a retry during the send is refused as it should be.
 */
function sendSignInCode({ email, otp, type }, ctx) {
	// Only sign-in codes are ever issued: the hook refuses any other type and the
	// other endpoints are closed. A different type reaching here is dropped, not mailed.
	if (type !== 'sign-in') return undefined;
	const job = deliverSignInCode({ email, otp }, ctx)
		.catch((error) => console.error(`Sign-in code bookkeeping failed: ${error.message}`))
		.finally(() => pendingSends.delete(job));
	pendingSends.add(job);
	return undefined;
}

/** Resolves once every background mail job started so far has finished. */
const settleSignInSends = () => Promise.allSettled([...pendingSends]);

const invalidCode = () => new APIError('BAD_REQUEST', { code: 'INVALID_OTP', message: 'Invalid OTP' });
const signInOtpIdentifier = (email) => `sign-in-otp-${email}`;

/**
 * Better Auth deletes an unverified account's password and sessions when an email
 * code proves control of its address, so such an account (staff whose email no admin
 * vouched for, or any row that never verified) must never reach that step. (On that
 * path Better Auth also reserves a verification row with a non-uuid id, which a
 * postgres uuid column rejects, so the request would fail as a 500 instead.) The caller
 * is answered exactly as for a wrong code or a normal send: a distinct answer would
 * tell anyone which addresses hold an unverified account.
 */
async function isUnverifiedAccount(ctx, email) {
	const found = await ctx.context.internalAdapter.findUserByEmail(email);
	return Boolean(found) && found.user.emailVerified !== true;
}

/**
 * Leaves the row an issued code would leave (same identifier, same `<hash>:0` shape, same
 * expiry) holding a random value nobody knows, so the wrong guesses that follow are
 * counted and expire exactly as they are for a real code and the number of attempts a
 * caller gets does not tell the two kinds of address apart.
 */
async function writeDecoyCode(ctx, email) {
	const { internalAdapter } = ctx.context;
	const identifier = signInOtpIdentifier(email);
	await internalAdapter.deleteVerificationByIdentifier(identifier);
	await internalAdapter.createVerificationValue({
		identifier,
		value: `${crypto.randomBytes(32).toString('base64url')}:0`,
		expiresAt: new Date(Date.now() + OTP_EXPIRES_IN_SECONDS * 1000)
	});
}

/**
 * The plugin's verification of a code, for an account that must never reach the plugin:
 * consume the row, refuse once the budget is spent, otherwise put it back one attempt
 * higher. No guess can succeed, because the decoy's value is unknown to everyone.
 */
async function refuseGuessAtUnverifiedAccount(ctx, email) {
	const { internalAdapter } = ctx.context;
	const identifier = signInOtpIdentifier(email);
	const existing = await internalAdapter.findVerificationValue(identifier);
	if (existing && existing.expiresAt < new Date()) {
		await internalAdapter.deleteVerificationByIdentifier(identifier);
		throw new APIError('BAD_REQUEST', { code: 'OTP_EXPIRED', message: 'OTP expired' });
	}
	const consumed = await internalAdapter.consumeVerificationValue(identifier);
	if (!consumed) throw invalidCode();
	const used = Number.parseInt(consumed.value.slice(consumed.value.lastIndexOf(':') + 1), 10) || 0;
	if (used >= OTP_ALLOWED_ATTEMPTS) throw new APIError('FORBIDDEN', { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts' });
	await internalAdapter.createVerificationValue({
		identifier,
		value: `${consumed.value.slice(0, consumed.value.lastIndexOf(':'))}:${used + 1}`,
		expiresAt: consumed.expiresAt
	});
	throw invalidCode();
}

// Fields a first sign-in would turn into account data. The username is generated
// server-side (a client value must not even reach the username plugin, which would answer
// "taken" for a name such as "admin" and leak which names exist); the image is a free URL
// that would be stored and rendered. `role` is left in on purpose: the plugin answers it
// with FIELD_NOT_ALLOWED, which is the signal wanted.
const SIGN_IN_STRIPPED_FIELDS = ['username', 'displayUsername', 'image'];

async function guardEmailCode(ctx) {
	const body = ctx.body;
	if (!body || typeof body.email !== 'string') {
		throw apiError('BAD_REQUEST', ERROR_CODES.BAD_REQUEST);
	}
	// Better Auth lowercases but does not trim; the guard and the plugin must agree on the key.
	body.email = body.email.trim().toLowerCase();
	// Before any lookup or row: a megabyte "address" must not reach a query or a stored key.
	// Answered as the plugin answers an invalid address.
	if (!isValidEmail(body.email)) {
		throw new APIError('BAD_REQUEST', { code: 'INVALID_EMAIL', message: 'Invalid email' });
	}

	if (ctx.path === OTP_SIGN_IN_PATH) {
		for (const field of SIGN_IN_STRIPPED_FIELDS) delete body[field];
		if (await isUnverifiedAccount(ctx, body.email)) return refuseGuessAtUnverifiedAccount(ctx, body.email);
		return undefined;
	}

	if (body.type !== 'sign-in') {
		throw apiError('BAD_REQUEST', ERROR_CODES.BAD_REQUEST);
	}
	// Answer before issuing a code that can never be delivered.
	if (!(await mailer.isMailAvailable())) {
		throw apiError('SERVICE_UNAVAILABLE', ERROR_CODES.OTP_MAIL_UNAVAILABLE);
	}
	if (await isCoolingDown(ctx, body.email)) {
		throw apiError('TOO_MANY_REQUESTS', ERROR_CODES.OTP_COOLDOWN);
	}
	await assertUnderSendCaps(ctx, body.email);
	await claimCooldown(ctx, body.email);

	// An unverified account takes the same cooldown and caps as any address (so a repeat
	// send answers alike) but is answered here, without a mail and without a usable code.
	// For everyone else the send is counted once the mail was accepted (sendSignInCode).
	if (await isUnverifiedAccount(ctx, body.email)) {
		await writeDecoyCode(ctx, body.email);
		await recordSend(ctx, body.email);
		return ctx.json({ success: true });
	}
	return undefined;
}

/**
 * Better Auth links Google to an existing local user whenever `google` is a trusted
 * provider, without looking at the token's `email_verified`. Refuse an unverified
 * Google address here, before the plugin runs. The claim is read without checking the
 * signature on purpose: the check can only refuse, and the plugin verifies the
 * signature next, so a forged token gains nothing.
 */
function guardOneTap(ctx) {
	const idToken = ctx.body?.idToken;
	if (typeof idToken !== 'string') return;
	let verified = false;
	try {
		const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'));
		verified = claims.email_verified === true || claims.email_verified === 'true';
	} catch {
		verified = false;
	}
	if (!verified) throw apiError('FORBIDDEN', ERROR_CODES.GOOGLE_EMAIL_UNVERIFIED);
}

/** An admin creating an account may not shadow a customer's: answer 409 instead of Better Auth's 400. */
async function guardAdminCreateUser(ctx) {
	const email = ctx.body?.email;
	if (typeof email !== 'string') return;
	const found = await ctx.context.internalAdapter.findUserByEmail(email.trim().toLowerCase());
	if (found && !isStaffRole(found.user.role)) {
		throw apiError('CONFLICT', ERROR_CODES.EMAIL_HELD_BY_CUSTOMER);
	}
}

/**
 * Self-service profile edits may not touch the login name: any signed-in customer could
 * otherwise take a name an admin wants to give a seller.
 */
function guardUpdateUser(ctx) {
	if (ctx.body && ('username' in ctx.body || 'displayUsername' in ctx.body)) {
		throw apiError('BAD_REQUEST', ERROR_CODES.BAD_REQUEST);
	}
}

// The admin update endpoint takes any user column (role, email, ban, ...). Role and
// email have their own audited paths, so only the two fields the seller form edits pass.
const ADMIN_UPDATE_FIELDS = ['name', 'username'];

/**
 * Only an admin session passes (the plugin repeats the check, but runs after this);
 * the body is then limited to what the seller form edits. The username plugin validates a rename against the
 * *session's* user id, so a rename onto the calling admin's own name would pass it and
 * die on the unique index; the uniqueness is checked here against the target instead.
 */
async function guardAdminUpdateUser(ctx) {
	// Settled before any lookup: the username check below answers "taken" for an existing
	// name, which would tell an anonymous caller or a customer which login names exist.
	const session = await getSessionFromCtx(ctx);
	if (!session) throw apiError('UNAUTHORIZED', ERROR_CODES.UNAUTHORIZED);
	if (!hasRole(session.user.role, 'admin')) throw apiError('FORBIDDEN', ERROR_CODES.FORBIDDEN);

	const data = ctx.body?.data;
	if (!data || typeof data !== 'object' || Array.isArray(data)) throw apiError('BAD_REQUEST', ERROR_CODES.BAD_REQUEST);
	const keys = Object.keys(data);
	if (keys.length === 0 || keys.some((key) => !ADMIN_UPDATE_FIELDS.includes(key))) throw apiError('BAD_REQUEST', ERROR_CODES.BAD_REQUEST);

	if ('name' in data) {
		const name = typeof data.name === 'string' ? data.name.trim() : '';
		if (!name || name.length > NAME_MAX_LENGTH) throw apiError('BAD_REQUEST', ERROR_CODES.BAD_REQUEST);
		data.name = name;
	}
	if ('username' in data) {
		if (typeof data.username !== 'string') throw apiError('BAD_REQUEST', ERROR_CODES.BAD_REQUEST);
		data.username = data.username.trim();
		const holder = await ctx.context.adapter.findOne({ model: 'user', where: [{ field: 'username', value: data.username.toLowerCase() }] });
		if (holder && String(holder.id) === String(ctx.body.userId)) {
			// Resending the current name is a no-op; the username plugin would call it taken (it compares with the admin).
			delete data.username;
		} else if (holder) {
			throw new APIError('BAD_REQUEST', { code: 'USERNAME_IS_ALREADY_TAKEN', message: 'Tên đăng nhập đã được sử dụng' });
		} else {
			// The login name and the name shown next to it stay one value, as on creation.
			data.displayUsername = data.username;
		}
	}
	if (Object.keys(data).length === 0) throw apiError('BAD_REQUEST', ERROR_CODES.BAD_REQUEST);
}

async function guardAuthRequest(ctx) {
	switch (ctx.path) {
		case OTP_SEND_PATH:
		case OTP_SIGN_IN_PATH:
			return guardEmailCode(ctx);
		case ONE_TAP_PATH:
			return guardOneTap(ctx);
		case ADMIN_CREATE_USER_PATH:
			return guardAdminCreateUser(ctx);
		case ADMIN_UPDATE_USER_PATH:
			return guardAdminUpdateUser(ctx);
		case '/update-user':
			return guardUpdateUser(ctx);
		default:
			return undefined;
	}
}

function randomCustomerUsername() {
	let suffix = '';
	for (let i = 0; i < USERNAME_LENGTH; i += 1) suffix += USERNAME_ALPHABET[crypto.randomInt(USERNAME_ALPHABET.length)];
	return `c_${suffix}`;
}

async function freeCustomerUsername(adapter) {
	for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt += 1) {
		const candidate = randomCustomerUsername();
		// eslint-disable-next-line no-await-in-loop
		const taken = await adapter.findOne({ model: 'user', where: [{ field: 'username', value: candidate }] });
		if (!taken) return candidate;
	}
	throw new Error('Could not allocate a customer username');
}

/**
 * `databaseHooks.user.create.before`. Two kinds of creator:
 * - an admin (`/admin/create-user`) or server code with no request (seeding) names the
 *   role and username itself; a staff address is vouched for by the admin who typed it,
 *   so it is stored verified (what makes email-code and Google sign-in safe for staff);
 * - everything else (email code, One Tap) is a self-registering customer: the role is
 *   forced, the username is always generated, and the address must already be verified.
 */
async function beforeUserCreate(user, ctx) {
	if (!ctx || ctx.path === ADMIN_CREATE_USER_PATH) {
		return isStaffRole(user.role) ? { data: { ...user, emailVerified: true } } : undefined;
	}

	if (user.emailVerified !== true) {
		throw apiError('FORBIDDEN', ERROR_CODES.GOOGLE_EMAIL_UNVERIFIED);
	}

	const username = await freeCustomerUsername(ctx.context.adapter);
	const given = typeof user.name === 'string' ? user.name.trim().slice(0, NAME_MAX_LENGTH) : '';
	const name = given || String(user.email).split('@')[0];
	return { data: { ...user, name, role: CUSTOMER_ROLE, username, displayUsername: username } };
}

module.exports = {
	OTP_EXPIRES_IN_SECONDS,
	CUSTOMER_ROLE,
	isStaffRole,
	guardAuthRequest,
	sendSignInCode,
	settleSignInSends,
	beforeUserCreate
};
