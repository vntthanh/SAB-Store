/**
 * Shared fixtures for the email-code, One Tap and staff-email tests. Every one of them
 * drives the real Better Auth plugins through the real HTTP handler; only the two
 * edges that leave the process are replaced (the mail transport, Google's key fetch).
 */
const request = require('supertest');
const { randomUUID } = require('crypto');
const { findUser } = require('../helpers/db');
const { settleSignInSends } = require('../../lib/auth-guards');

// Each request comes from its own address so the per-address limiter (keyed on the
// client IP Better Auth resolves from X-Forwarded-For, which the loopback test peer is
// trusted to set) never couples two tests. 203.0.113.0/24 is documentation space.
let ipCounter = 0;
const nextIp = () => {
	ipCounter += 1;
	return `203.0.113.${ipCounter % 250 + 1}`;
};

const uniqueEmail = (prefix = 'buyer') => `${prefix}-${randomUUID()}@test.local`;

/** POST to the Better Auth handler as a client at `ip` (a fresh one by default). */
const authPost = (app, path, body, { ip = nextIp(), cookies } = {}) => {
	const req = request(app).post(`/api/auth${path}`).set('X-Forwarded-For', ip);
	return (cookies ? req.set('Cookie', cookies) : req).send(body);
};

const postSendCode = (app, email, extra = {}, options) =>
	authPost(app, '/email-otp/send-verification-otp', { email, type: 'sign-in', ...extra }, options);

// The mail goes out after the response; waiting for it settles the captured mail and the caps.
const sendCode = async (...args) => {
	const res = await postSendCode(...args);
	await settleSignInSends();
	return res;
};

const signInWithCode = (app, email, otp, extra = {}, options) =>
	authPost(app, '/sign-in/email-otp', { email, otp, ...extra }, options);

/**
 * Replaces the mail edge: mail reads as available and every message is captured
 * instead of sent. Restored by vi.restoreAllMocks().
 */
function captureMail({ result = 'sent' } = {}) {
	const mailer = require('../../services/mailer');
	const sent = [];
	vi.spyOn(mailer, 'isMailAvailable').mockResolvedValue(true);
	vi.spyOn(mailer, 'sendMail').mockImplementation(async (message) => {
		sent.push(message);
		return result;
	});
	return sent;
}

/** The six-digit code in a captured sign-in mail. */
const codeOf = (message) => /(?<!\d)(\d{6})(?!\d)/.exec(message.text)[1];

/** Writes columns Better Auth does not let an HTTP client set (verified, banned). */
async function setUserColumns(email, data) {
	const { auth } = require('../../lib/auth');
	const context = await auth.$context;
	const user = await findUser({ email });
	await context.internalAdapter.updateUser(user._id, data);
	return user._id;
}

module.exports = { uniqueEmail, authPost, postSendCode, sendCode, signInWithCode, captureMail, codeOf, setUserColumns };
