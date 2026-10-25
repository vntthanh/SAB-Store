const request = require('supertest');
const express = require('express');
const http = require('http');
const { buildTestApp } = require('../helpers/app');
const { trackServer } = require('../helpers/servers');
const { createAccount, signInSession, makeAdminSession } = require('../helpers/factories');
const { findUser, findAuthRows, countRows } = require('../helpers/db');
const { authenticateOptional } = require('../../middleware/better-auth');
const { settleSignInSends } = require('../../lib/auth-guards');
const { uniqueEmail, authPost, postSendCode, sendCode, signInWithCode, captureMail, codeOf, setUserColumns } = require('./auth-test-kit');

describe('email code sign-in', () => {
	let app;
	let sent;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(() => {
		sent = captureMail();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const verificationRow = async (identifier) => (await findAuthRows('verification')).find((row) => row.identifier === identifier);

	async function signInAsCustomer(email = uniqueEmail()) {
		await sendCode(app, email);
		const res = await signInWithCode(app, email, codeOf(sent.at(-1)));
		expect(res.status).toBe(200);
		return { email, cookies: res.headers['set-cookie'], body: res.body };
	}

	describe('registering a customer', () => {
		it('creates a verified customer with a generated username, ignoring a username, image and blank name in the body', async () => {
			const email = uniqueEmail();
			expect((await sendCode(app, email)).status).toBe(200);
			expect(sent).toHaveLength(1);
			expect(sent[0].to).toBe(email);

			const res = await signInWithCode(app, email, codeOf(sent[0]), { username: 'admin', displayUsername: 'Admin', name: '   ', image: 'https://attacker.example/x.png' });

			expect(res.status).toBe(200);
			const stored = await findUser({ email });
			expect(stored.role).toBe('customer');
			expect(stored.username).toMatch(/^c_[0-9a-z]{12}$/);
			expect(stored.emailVerified).toBe(true);
			expect(stored.image ?? null).toBeNull();
			// No name given: the address's local part stands in.
			expect(stored.name).toBe(email.split('@')[0]);
			expect(res.headers['set-cookie']).toBeDefined();
		});

		it('refuses a body that names a role, and creates nobody', async () => {
			const email = uniqueEmail();
			await sendCode(app, email);

			const res = await signInWithCode(app, email, codeOf(sent[0]), { role: 'admin' });

			expect(res.status).toBe(400);
			expect(res.body.code).toBe('FIELD_NOT_ALLOWED');
			expect(await countRows('user', { email })).toBe(0);
		});

		it('exposes role, email and emailVerified on the session', async () => {
			const { email, cookies } = await signInAsCustomer();

			const session = await request(app).get('/api/auth/get-session').set('Cookie', cookies);

			expect(session.body.user).toMatchObject({ email, role: 'customer', emailVerified: true });
		});

		it('trims and lowercases the address before the code is issued and checked', async () => {
			const raw = `  Mixed.${Date.now()}@Test.Local `;
			const email = raw.trim().toLowerCase();

			expect((await sendCode(app, raw)).status).toBe(200);
			expect(sent[0].to).toBe(email);

			const res = await signInWithCode(app, raw, codeOf(sent[0]));
			expect(res.status).toBe(200);
			expect((await findUser({ email })).email).toBe(email);
		});

		it('never stores the plain code', async () => {
			const email = uniqueEmail();
			await sendCode(app, email);

			const row = await verificationRow(`sign-in-otp-${email}`);

			expect(row).toBeDefined();
			expect(row.value).not.toContain(codeOf(sent[0]));
			expect(row.value).toMatch(/^[A-Za-z0-9_-]{43}:0$/);
		});
	});

	describe('what a send refuses', () => {
		it.each(['forget-password', 'email-verification', 'change-email', 'not-a-type'])('refuses the %s type and sends nothing', async (type) => {
			const res = await sendCode(app, uniqueEmail(), { type });

			expect(res.status).toBe(400);
			expect(sent).toHaveLength(0);
			expect(await countRows('verification')).toBe(0);
		});

		it('refuses an address that is not an address or is over 254 characters, before any row is written', async () => {
			const huge = `${'a'.repeat(5000)}@test.local`;
			const long = `${'a'.repeat(250)}@test.local`;

			const results = await Promise.all([huge, long, 'not-an-email', '   '].flatMap((email) => [postSendCode(app, email), signInWithCode(app, email, '123456')]));
			await settleSignInSends();

			for (const res of results) {
				expect(res.status).toBe(400);
				expect(res.body.code).toBe('INVALID_EMAIL');
			}
			expect(sent).toHaveLength(0);
			expect(await countRows('verification')).toBe(0);
		});

		it('refuses an email that is not a string', async () => {
			const objectEmail = await authPost(app, '/email-otp/send-verification-otp', { email: { $ne: null }, type: 'sign-in' });
			const numberSignIn = await authPost(app, '/sign-in/email-otp', { email: 123456, otp: '123456' });

			expect(objectEmail.status).toBe(400);
			expect(numberSignIn.status).toBe(400);
			expect(sent).toHaveLength(0);
		});

		it('answers OTP_MAIL_UNAVAILABLE and issues no code while mail is off', async () => {
			const mailer = require('../../services/mailer');
			mailer.isMailAvailable.mockResolvedValue(false);

			const res = await sendCode(app, uniqueEmail());

			expect(res.status).toBe(503);
			expect(res.body.code).toBe('OTP_MAIL_UNAVAILABLE');
			expect(mailer.sendMail).not.toHaveBeenCalled();
			expect(await countRows('verification')).toBe(0);
		});
	});

	describe('the per-address cooldown', () => {
		it('refuses a second send within the minute', async () => {
			const email = uniqueEmail();
			expect((await sendCode(app, email)).status).toBe(200);

			const second = await sendCode(app, email);

			expect(second.status).toBe(429);
			expect(second.body.code).toBe('OTP_COOLDOWN');
			expect(sent).toHaveLength(1);
		});

		it('is kept in its own row and not extended by wrong guesses', async () => {
			const email = uniqueEmail();
			await sendCode(app, email);
			const before = await verificationRow(`otp-cooldown:${email}`);
			expect(before).toBeDefined();

			for (let i = 0; i < 3; i += 1) {
				// eslint-disable-next-line no-await-in-loop
				expect((await signInWithCode(app, email, '000000')).status).toBe(400);
			}

			const after = await verificationRow(`otp-cooldown:${email}`);
			expect(new Date(after.expiresAt).getTime()).toBe(new Date(before.expiresAt).getTime());
			// The guesses burned attempts, not the code: the real one still works.
			expect((await signInWithCode(app, email, codeOf(sent[0]))).status).toBe(200);
		});

		it('is taken before the mail goes out and given back when the mail was not sent', async () => {
			const mailer = require('../../services/mailer');
			const email = uniqueEmail();
			let cooldownDuringSend;
			mailer.sendMail.mockImplementation(async () => {
				cooldownDuringSend = await verificationRow(`otp-cooldown:${email}`);
				return 'failed';
			});

			expect((await sendCode(app, email)).status).toBe(200);
			expect(cooldownDuringSend).toBeDefined();
			expect(await verificationRow(`otp-cooldown:${email}`)).toBeUndefined();
			// A failed send leaves both caps untouched.
			const rows = await findAuthRows('verification');
			expect(rows.filter((row) => row.identifier === `otp-sent:${email}` || row.identifier === 'otp-sent:*')).toHaveLength(0);

			mailer.sendMail.mockResolvedValue('sent');
			expect((await sendCode(app, email)).status).toBe(200);
			expect(await verificationRow(`otp-cooldown:${email}`)).toBeDefined();
		});

		it('answers before the mail transport does', async () => {
			const mailer = require('../../services/mailer');
			let release;
			mailer.sendMail.mockImplementation(() => new Promise((resolve) => { release = () => resolve('sent'); }));
			const email = uniqueEmail();

			const res = await postSendCode(app, email);

			expect(res.status).toBe(200);
			// The send is still in flight: the cooldown is held, nothing is counted yet.
			await vi.waitFor(() => expect(release).toBeDefined());
			expect(await verificationRow(`otp-cooldown:${email}`)).toBeDefined();
			expect(await verificationRow(`otp-sent:${email}`)).toBeUndefined();
			release();
			await settleSignInSends();
			expect(await verificationRow(`otp-sent:${email}`)).toBeDefined();
		});

		it('survives a transport that throws: no cooldown, nothing counted, no unhandled rejection', async () => {
			const mailer = require('../../services/mailer');
			mailer.sendMail.mockRejectedValue(new Error('smtp down'));
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const email = uniqueEmail();

			expect((await sendCode(app, email)).status).toBe(200);

			expect(await verificationRow(`otp-cooldown:${email}`)).toBeUndefined();
			expect(await verificationRow(`otp-sent:${email}`)).toBeUndefined();
		});

		it('lets only one of several concurrent sends to the same address through', async () => {
			const email = uniqueEmail();

			const results = await Promise.all(Array.from({ length: 4 }, () => sendCode(app, email)));

			expect(results.filter((res) => res.status === 200)).toHaveLength(1);
			expect(results.filter((res) => res.status === 429)).toHaveLength(3);
			expect(sent).toHaveLength(1);
			expect((await findAuthRows('verification')).filter((row) => row.identifier === `otp-cooldown:${email}`)).toHaveLength(1);
		});

		it('burns the code after five wrong guesses', async () => {
			const email = uniqueEmail();
			await sendCode(app, email);

			for (let i = 0; i < 5; i += 1) {
				// eslint-disable-next-line no-await-in-loop
				await signInWithCode(app, email, '000000');
			}

			const res = await signInWithCode(app, email, codeOf(sent[0]));
			expect(res.status).toBe(403);
			expect(await findUser({ email })).toBeNull();
		});
	});

	describe('the send caps', () => {
		// Rows are written straight into the store the guard counts from, as earlier sends would have left them.
		async function seedSends(identifier, count, ttlMs) {
			const { auth } = require('../../lib/auth');
			const context = await auth.$context;
			for (let i = 0; i < count; i += 1) {
				// eslint-disable-next-line no-await-in-loop
				await context.internalAdapter.createVerificationValue({ identifier, value: '1', expiresAt: new Date(Date.now() + ttlMs) });
			}
		}
		const DAY = 24 * 60 * 60 * 1000;
		const HOUR = 60 * 60 * 1000;

		it('refuses an eleventh send to one address in a day with a generic code, and logs no address', async () => {
			const email = uniqueEmail();
			await seedSends(`otp-sent:${email}`, 10, DAY);
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const res = await sendCode(app, email);

			expect(res.status).toBe(429);
			expect(res.body.code).toBe('OTP_LIMIT_REACHED');
			expect(res.body.message).toBe('Đã gửi quá nhiều mã, vui lòng thử lại sau');
			expect(sent).toHaveLength(0);
			const logged = warn.mock.calls.map((call) => call.join(' ')).filter((line) => line.includes('limit reached'));
			expect(logged).toHaveLength(1);
			expect(logged[0]).not.toContain(email);
			expect(await verificationRow(`otp-cooldown:${email}`)).toBeUndefined();
		});

		it('still allows a tenth send to the address', async () => {
			const email = uniqueEmail();
			await seedSends(`otp-sent:${email}`, 9, DAY);

			expect((await sendCode(app, email)).status).toBe(200);
		});

		it('refuses any address once 300 codes went out in the hour', async () => {
			await seedSends('otp-sent:*', 300, HOUR);
			vi.spyOn(console, 'warn').mockImplementation(() => {});

			const res = await sendCode(app, uniqueEmail());

			expect(res.status).toBe(429);
			expect(res.body.code).toBe('OTP_LIMIT_REACHED');
			expect(sent).toHaveLength(0);
		});

		it('does not count sends that have expired', async () => {
			const email = uniqueEmail();
			await seedSends(`otp-sent:${email}`, 10, -1000);

			expect((await sendCode(app, email)).status).toBe(200);
		});

		it('counts every accepted send against both caps', async () => {
			const email = uniqueEmail();
			await sendCode(app, email);

			const rows = await findAuthRows('verification');
			expect(rows.filter((row) => row.identifier === `otp-sent:${email}`)).toHaveLength(1);
			expect(rows.filter((row) => row.identifier === 'otp-sent:*')).toHaveLength(1);
		});
	});

	describe('the per-client limiter', () => {
		it('allows three sends a minute from one client and limits the fourth', async () => {
			const ip = '198.51.100.7';
			const statuses = [];
			for (let i = 0; i < 4; i += 1) {
				// eslint-disable-next-line no-await-in-loop
				statuses.push((await sendCode(app, uniqueEmail(), {}, { ip })).status);
			}

			expect(statuses).toEqual([200, 200, 200, 429]);
		});

		it('allows ten sign-in attempts in five minutes from one client and limits the eleventh', async () => {
			const ip = '198.51.100.8';
			const statuses = [];
			for (let i = 0; i < 11; i += 1) {
				// eslint-disable-next-line no-await-in-loop
				statuses.push((await signInWithCode(app, uniqueEmail(), '000000', {}, { ip })).status);
			}

			expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
			expect(statuses[10]).toBe(429);
		});
	});

	describe('closed endpoints', () => {
		it.each([
			'/email-otp/verify-email',
			'/email-otp/check-verification-otp',
			'/email-otp/request-password-reset',
			'/forget-password/email-otp',
			'/email-otp/reset-password',
			'/email-otp/request-email-change',
			'/email-otp/change-email'
		])('answers 404 on %s', async (path) => {
			const email = uniqueEmail();
			const res = await authPost(app, path, { email, otp: '123456', password: 'Str0ngPassw0rd!', newEmail: uniqueEmail() });

			expect(res.status).toBe(404);
			expect(sent).toHaveLength(0);
		});

		it('cannot set a password through a code', async () => {
			const { email } = await signInAsCustomer();

			const res = await authPost(app, '/email-otp/reset-password', { email, otp: codeOf(sent[0]), password: 'Str0ngPassw0rd!' });

			expect(res.status).toBe(404);
			expect((await findAuthRows('account')).filter((row) => row.providerId === 'credential')).toHaveLength(0);
		});

		it('has no HTTP route for reading a code', async () => {
			const res = await request(app).get('/api/auth/email-otp/get-verification-otp').query({ email: uniqueEmail(), type: 'sign-in' });

			expect(res.status).toBe(404);
		});

		it('refuses to change a login name through update-user, and refuses a body that sets a role', async () => {
			const { cookies } = await signInAsCustomer();

			const rename = await authPost(app, '/update-user', { username: 'future_seller' }, { cookies });
			const promote = await authPost(app, '/update-user', { name: 'x', role: 'admin' }, { cookies });
			const display = await authPost(app, '/update-user', { displayUsername: 'Future Seller' }, { cookies });

			expect(rename.status).toBe(400);
			expect(display.status).toBe(400);
			expect(promote.status).toBe(400);
			expect(promote.body.code).toBe('FIELD_NOT_ALLOWED');
			const session = await request(app).get('/api/auth/get-session').set('Cookie', cookies);
			expect(session.body.user.role).toBe('customer');
		});
	});

	describe('staff accounts', () => {
		it.each(['seller', 'admin'])('lets a verified %s sign in by code, keeping the role, password and sessions', async (role) => {
			const account = await createAccount({ role, prefix: role });
			expect((await findUser({ email: account.email })).emailVerified).toBe(true);
			const earlier = await signInSession(app, account);
			await sendCode(app, account.email);

			const res = await signInWithCode(app, account.email, codeOf(sent[0]));

			expect(res.status).toBe(200);
			expect((await findUser({ email: account.email })).role).toBe(role);
			const session = await request(app).get('/api/auth/get-session').set('Cookie', res.headers['set-cookie']);
			expect(session.body.user.role).toBe(role);
			// The password and the session that predate the code both survive.
			await signInSession(app, account);
			const stillSignedIn = await request(app).get('/api/auth/get-session').set('Cookie', earlier);
			expect(stillSignedIn.body?.user?.email).toBe(account.email);
		});

		it.each([
			['seller', 'seller'],
			['admin', 'admin'],
			['customer', undefined]
		])('treats an unverified %s account like any address: same answers, no mail, password untouched', async (_label, role) => {
			const account = await createAccount({ role, prefix: 'unverified' });
			const userId = await setUserColumns(account.email, { emailVerified: false });
			const stranger = uniqueEmail();

			const send = await sendCode(app, account.email);
			const strangerSend = await sendCode(app, stranger);
			const again = await sendCode(app, account.email);
			const signIn = await signInWithCode(app, account.email, '123456');
			const strangerSignIn = await signInWithCode(app, stranger, '123456');

			// Sending is answered as a success, and a repeat as a cooldown, exactly as for an address with no account.
			expect(send.status).toBe(200);
			expect(send.body).toEqual(strangerSend.body);
			expect(again.status).toBe(429);
			expect(again.body.code).toBe('OTP_COOLDOWN');
			// Signing in is answered as a wrong code is.
			expect(signIn.status).toBe(400);
			expect(signIn.body).toEqual(strangerSignIn.body);
			expect(signIn.body.code).toBe('INVALID_OTP');
			expect(signIn.headers['set-cookie']).toBeUndefined();
			// Only the unknown address got a mail, and the account row was never touched.
			expect(sent.map((message) => message.to)).toEqual([stranger]);
			// The decoy row the failed guess above bumped: same shape as a real code's, never matchable.
			expect(await verificationRow(`sign-in-otp-${account.email}`)).toMatchObject({ value: expect.stringMatching(/^[A-Za-z0-9_-]{43}:1$/) });
			const credential = (await findAuthRows('account')).filter((row) => String(row.userId) === String(userId) && row.providerId === 'credential');
			expect(credential).toHaveLength(1);
			expect((await findUser({ email: account.email })).emailVerified).toBe(false);
			await signInSession(app, account);
		});

		it('counts wrong guesses at an unverified account exactly as at an address holding a real code', async () => {
			const account = await createAccount({ role: 'seller', prefix: 'oracle' });
			await setUserColumns(account.email, { emailVerified: false });
			const sequence = async (email) => {
				await sendCode(app, email);
				const out = [];
				for (let i = 0; i < 7; i += 1) {
					// eslint-disable-next-line no-await-in-loop
					const res = await signInWithCode(app, email, '000000');
					out.push([res.status, res.body.code]);
				}
				return out;
			};

			const realCode = await sequence(uniqueEmail());
			const decoy = await sequence(account.email);

			expect(decoy).toEqual(realCode);
			expect(decoy.map(([status]) => status)).toEqual([400, 400, 400, 400, 400, 403, 400]);
			expect(decoy[5][1]).toBe('TOO_MANY_ATTEMPTS');
			expect(await verificationRow(`sign-in-otp-${account.email}`)).toBeUndefined();
		});

		it('refuses a banned staff account a session', async () => {
			const account = await createAccount({ role: 'seller', prefix: 'banned' });
			await setUserColumns(account.email, { banned: true, banReason: 'test' });
			await sendCode(app, account.email);

			const res = await signInWithCode(app, account.email, codeOf(sent[0]));

			expect(res.status).toBe(403);
			expect(res.body.code).toBe('BANNED_USER');
			expect(res.headers['set-cookie']).toBeUndefined();
		});
	});

	describe('accounts an admin creates', () => {
		let admin;

		beforeEach(async () => {
			admin = await makeAdminSession(app);
		});

		const createViaAdmin = (body) => authPost(app, '/admin/create-user', body, { cookies: admin.cookies });

		it.each(['seller', 'admin'])('stores a %s with a verified email whatever the request says', async (role) => {
			const email = uniqueEmail(role);

			const res = await createViaAdmin({
				email,
				password: 'Str0ngPassw0rd!',
				name: 'New Staff',
				role,
				data: { username: `${role}_${Date.now()}`, emailVerified: false }
			});

			expect(res.status).toBe(200);
			expect((await findUser({ email })).emailVerified).toBe(true);
		});

		it('answers 409 when the email already belongs to a customer', async () => {
			const { email } = await signInAsCustomer();

			const res = await createViaAdmin({
				email: email.toUpperCase(),
				password: 'Str0ngPassw0rd!',
				name: 'Clash',
				role: 'seller',
				data: { username: `clash_${Date.now()}` }
			});

			expect(res.status).toBe(409);
			expect(res.body.code).toBe('EMAIL_HELD_BY_CUSTOMER');
			expect(res.body.message).toBe('Email đã thuộc một tài khoản khách hàng');
			expect((await findUser({ email })).role).toBe('customer');
		});
	});

	describe('what a customer session may reach', () => {
		it.each(['/api/admin/orders', '/api/seller/orders'])('answers 403 on %s', async (path) => {
			const { cookies } = await signInAsCustomer();

			const res = await request(app).get(path).set('Cookie', cookies);

			expect(res.status).toBe(403);
		});
	});

	describe('authenticateOptional', () => {
		let viewerApp;

		beforeAll(() => {
			const probe = express();
			probe.get('/who', authenticateOptional, (req, res) => res.json({ viewer: req.viewer }));
			viewerApp = trackServer(http.createServer(probe).listen(0));
		});

		it('identifies a signed-in customer', async () => {
			const { email, cookies } = await signInAsCustomer();

			const res = await request(viewerApp).get('/who').set('Cookie', cookies);

			expect(res.status).toBe(200);
			expect(res.body.viewer).toMatchObject({ email, role: 'customer', emailVerified: true });
			expect(res.body.viewer.id).toBeTruthy();
		});

		it('lets an anonymous request or a garbage cookie through as null, never 401', async () => {
			const anonymous = await request(viewerApp).get('/who');
			const garbage = await request(viewerApp).get('/who').set('Cookie', 'better-auth.session_token=not-a-session');

			expect(anonymous.status).toBe(200);
			expect(anonymous.body.viewer).toBeNull();
			expect(garbage.status).toBe(200);
			expect(garbage.body.viewer).toBeNull();
		});
	});
});
