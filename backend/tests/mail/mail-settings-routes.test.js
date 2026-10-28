const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession, makeSellerSession, makeProduct, makeOrder } = require('../helpers/factories');
const { MAIL_BODY, stubTransport } = require('../helpers/mail');
const { decryptSecret } = require('../../lib/secret-box');
const { mailSettings } = require('../../data');
const { prisma } = require('../../lib/prisma');

describe('admin mail settings routes', () => {
	let app;
	let cookies;
	let admin;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		admin = await makeAdminSession(app);
		cookies = admin.cookies;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const get = () => request(app).get('/api/admin/settings/mail').set('Cookie', cookies);
	const put = (body) => request(app).put('/api/admin/settings/mail').set('Cookie', cookies).send(body);
	const sendTest = (body, session = cookies) => request(app).post('/api/admin/settings/mail/test').set('Cookie', session).send(body);

	describe('GET', () => {
		it('answers null before anything is saved', async () => {
			const res = await get();
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ success: true, data: null });
		});

		it('never returns the password or its ciphertext', async () => {
			await put(MAIL_BODY);

			const res = await get();

			expect(res.status).toBe(200);
			expect(res.body.data).toMatchObject({
				enabled: true,
				host: MAIL_BODY.host,
				port: 587,
				secure: false,
				username: MAIL_BODY.username,
				fromName: MAIL_BODY.fromName,
				fromAddress: MAIL_BODY.fromAddress,
				notifyOrderCreated: true,
				notifyStatusChanged: true,
				hasPassword: true
			});
			const raw = JSON.stringify(res.body);
			expect(raw).not.toContain(MAIL_BODY.pass);
			expect(raw).not.toMatch(/"pass(Encrypted)?"\s*:/);
			expect(res.body.data).not.toHaveProperty('pass');
			expect(res.body.data).not.toHaveProperty('passEncrypted');
		});
	});

	describe('PUT', () => {
		it('stores the password encrypted and returns the same shape as GET', async () => {
			const res = await put(MAIL_BODY);

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(res.body.data).toMatchObject({ hasPassword: true, enabled: true, updatedBy: expect.any(String) });
			expect(JSON.stringify(res.body)).not.toContain(MAIL_BODY.pass);

			const stored = await mailSettings.findConfig();
			expect(stored.passEncrypted).not.toContain(MAIL_BODY.pass);
			expect(decryptSecret(stored.passEncrypted)).toBe(MAIL_BODY.pass);
			expect((await get()).body.data).toEqual(res.body.data);
		});

		it('keeps the stored password when pass is omitted or empty', async () => {
			await put(MAIL_BODY);
			const before = (await mailSettings.findConfig()).passEncrypted;

			const { pass, ...withoutPass } = MAIL_BODY;
			const omitted = await put({ ...withoutPass, host: 'smtp2.test.example' });
			const empty = await put({ ...withoutPass, host: 'smtp2.test.example', pass: '', port: 465, secure: true });

			expect(omitted.status).toBe(200);
			expect(empty.status).toBe(200);
			const stored = await mailSettings.findConfig();
			expect(stored).toMatchObject({ host: 'smtp2.test.example', port: 465, secure: true });
			expect(stored.passEncrypted).toBe(before);
		});

		it('replaces the password when a new one is sent', async () => {
			await put(MAIL_BODY);

			await put({ ...MAIL_BODY, pass: 'another-pass' });

			expect(decryptSecret((await mailSettings.findConfig()).passEncrypted)).toBe('another-pass');
		});

		it('refuses the first save without a password and stores nothing', async () => {
			const { pass, ...withoutPass } = MAIL_BODY;

			const res = await put(withoutPass);

			expect(res.status).toBe(400);
			expect(res.body).toMatchObject({ success: false, message: expect.any(String) });
			expect(await mailSettings.findConfig()).toBeNull();
		});

		it.each([
			['a missing host', { host: '' }],
			['a port above 65535', { port: 70000 }],
			['a non-integer port', { port: 25.5 }],
			['a malformed sender address', { fromAddress: 'not-an-email' }],
			['a non-boolean switch', { enabled: 'yes' }],
			['an over-long password', { pass: 'x'.repeat(257) }]
		])('answers 400 for %s', async (_label, patch) => {
			const res = await put({ ...MAIL_BODY, ...patch });

			expect(res.status).toBe(400);
			expect(await mailSettings.findConfig()).toBeNull();
		});

		it('does not echo a rejected password back', async () => {
			const tooLong = `Z${'x'.repeat(300)}`;

			const res = await put({ ...MAIL_BODY, pass: tooLong });

			expect(res.status).toBe(400);
			expect(JSON.stringify(res.body)).not.toContain(tooLong);
		});

		it('ignores fields outside the contract', async () => {
			await put({ ...MAIL_BODY, passEncrypted: 'v1:a:b:c', updatedBy: 'attacker', key: 'other' });

			const stored = await mailSettings.findConfig();
			expect(decryptSecret(stored.passEncrypted)).toBe(MAIL_BODY.pass);
			expect(stored.updatedBy).toBe(admin.username);
			expect(stored.key).toBeUndefined();

			// The injected `key` would have started a second row instead of updating the first.
			const rows = await prisma.mailSettings.findMany();
			expect(rows).toHaveLength(1);
			expect(rows[0].key).toBe('smtp');
		});
	});

	describe('POST /test', () => {
		it('refuses with 400 when nothing is saved, without opening a transport', async () => {
			const { createTransport } = stubTransport();

			const res = await sendTest({ to: 'admin@test.example' });

			expect(res.status).toBe(400);
			expect(res.body.success).toBe(false);
			expect(createTransport).not.toHaveBeenCalled();
		});

		it('sends through the saved account even while the master switch is off', async () => {
			await put({ ...MAIL_BODY, enabled: false });
			const { createTransport, sendMail } = stubTransport();

			const res = await sendTest({ to: 'admin@test.example' });

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(createTransport).toHaveBeenCalledTimes(1);
			expect(createTransport.mock.calls[0][0]).toMatchObject({
				host: MAIL_BODY.host,
				port: 587,
				auth: { user: MAIL_BODY.username, pass: MAIL_BODY.pass },
				connectionTimeout: 10_000,
				greetingTimeout: 10_000,
				socketTimeout: 20_000
			});
			expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'admin@test.example' }));
		});

		it('answers 502 with a message that carries neither the username nor the password', async () => {
			await put(MAIL_BODY);
			const failure = Object.assign(new Error('auth'), {
				code: 'EAUTH',
				responseCode: 535,
				response: `535 bad login ${MAIL_BODY.username} / ${MAIL_BODY.pass} / ${Buffer.from(`\0${MAIL_BODY.username}\0${MAIL_BODY.pass}`).toString('base64')}`
			});
			stubTransport({ sendMail: vi.fn().mockRejectedValue(failure) });

			const res = await sendTest({ to: 'admin@test.example' });

			expect(res.status).toBe(502);
			expect(res.body.success).toBe(false);
			expect(res.body.message).toMatch(/^EAUTH 535/);
			expect(res.body.message.length).toBeLessThanOrEqual(200);
			expect(JSON.stringify(res.body)).not.toContain(MAIL_BODY.pass);
			expect(JSON.stringify(res.body)).not.toContain(MAIL_BODY.username);
		});

		it('rejects a malformed recipient', async () => {
			await put(MAIL_BODY);
			const { createTransport } = stubTransport();

			const res = await sendTest({ to: 'nope' });

			expect(res.status).toBe(400);
			expect(createTransport).not.toHaveBeenCalled();
		});

		it('allows five test sends per admin in a window and then answers 429', async () => {
			await put(MAIL_BODY);
			const { sendMail } = stubTransport();

			const statuses = [];
			for (let i = 0; i < 6; i++) statuses.push((await sendTest({ to: 'admin@test.example' })).status);

			expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
			expect(sendMail).toHaveBeenCalledTimes(5);

			const other = await makeAdminSession(app);
			expect((await sendTest({ to: 'admin@test.example' }, other.cookies)).status).toBe(200);
		});
	});

	describe('access', () => {
		it('answers 401 without a session and 403 for a seller, on every route', async () => {
			const seller = await makeSellerSession(app);
			const calls = [
				(r) => r.get('/api/admin/settings/mail'),
				(r) => r.put('/api/admin/settings/mail').send(MAIL_BODY),
				(r) => r.post('/api/admin/settings/mail/test').send({ to: 'a@test.example' })
			];

			for (const call of calls) {
				expect((await call(request(app))).status).toBe(401);
				expect((await call(request(app)).set('Cookie', seller.cookies)).status).toBe(403);
			}
			expect(await mailSettings.findConfig()).toBeNull();
		});
	});

	describe('database export', () => {
		it('carries neither the mail settings nor the encrypted password', async () => {
			await put(MAIL_BODY);
			await makeProduct();
			await makeOrder();
			const { passEncrypted } = await mailSettings.findConfig();

			const res = await request(app).get('/api/admin/database/export').set('Cookie', cookies);

			expect(res.status).toBe(200);
			const raw = JSON.stringify(res.body);
			expect(raw).not.toContain(passEncrypted);
			expect(raw).not.toContain(MAIL_BODY.pass);
			expect(raw).not.toContain(MAIL_BODY.host);
			expect(Object.keys(res.body.data)).not.toContain('mailSettings');
			expect(Object.keys(res.body.data)).not.toContain('mail_settings');
		});
	});
});
