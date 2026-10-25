// Read when lib/auth.js loads (the plugin is registered only when this is set), so it
// must be in place before anything below pulls the app in.
const CLIENT_ID = 'sab-test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_ID = CLIENT_ID;

const request = require('supertest');
const { generateKeyPairSync, createSign, randomUUID } = require('crypto');
const { buildTestApp } = require('../helpers/app');
const { createAccount, signInSession } = require('../helpers/factories');
const { findUser, findAuthRows, countRows } = require('../helpers/db');
const { uniqueEmail, authPost, setUserColumns } = require('./auth-test-kit');

// The plugin verifies the ID token against Google's published keys, fetched over the
// network. Only that fetch is replaced: tokens are really signed here and really
// verified (signature, issuer, audience, age) by the installed plugin.
const KEY_ID = 'sab-test-key';
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: strangerKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publishedJwk = { ...publicKey.export({ format: 'jwk' }), kid: KEY_ID, alg: 'RS256', use: 'sig' };

function idToken(claims = {}, { signWith = privateKey } = {}) {
	const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
	const now = Math.floor(Date.now() / 1000);
	const header = encode({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' });
	const payload = encode({
		iss: 'https://accounts.google.com',
		aud: CLIENT_ID,
		sub: randomUUID(),
		iat: now,
		exp: now + 3600,
		email_verified: true,
		...claims
	});
	const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(signWith).toString('base64url');
	return `${header}.${payload}.${signature}`;
}

describe('Google One Tap sign-in', () => {
	let app;
	const realFetch = globalThis.fetch;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn(async (input, init) => {
			const url = typeof input === 'string' ? input : input.url ?? String(input);
			if (url.startsWith(GOOGLE_CERTS_URL)) {
				return new Response(JSON.stringify({ keys: [publishedJwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			return realFetch(input, init);
		}));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const tap = (token) => authPost(app, '/one-tap/callback', { idToken: token });
	const googleAccountsOf = async (userId) =>
		(await findAuthRows('account')).filter((row) => String(row.userId) === String(userId) && row.providerId === 'google');

	it('registers a new email as a verified customer with a generated username', async () => {
		const email = uniqueEmail('tapper');

		const res = await tap(idToken({ email, name: 'Khách Hàng' }));

		expect(res.status).toBe(200);
		expect(res.headers['set-cookie']).toBeDefined();
		const stored = await findUser({ email });
		expect(stored).toMatchObject({ role: 'customer', emailVerified: true, name: 'Khách Hàng' });
		expect(stored.username).toMatch(/^c_[0-9a-z]{12}$/);
		expect(await googleAccountsOf(stored._id)).toHaveLength(1);
	});

	it('gives a verified staff member their staff session and keeps role and password', async () => {
		const account = await createAccount({ role: 'seller', prefix: 'tapstaff' });

		const res = await tap(idToken({ email: account.email.toUpperCase() }));

		expect(res.status).toBe(200);
		const session = await request(app).get('/api/auth/get-session').set('Cookie', res.headers['set-cookie']);
		expect(session.body.user).toMatchObject({ email: account.email, role: 'seller' });
		const stored = await findUser({ email: account.email });
		expect(stored.role).toBe('seller');
		expect(await googleAccountsOf(stored._id)).toHaveLength(1);
		await signInSession(app, account);
	});

	it('refuses a staff account whose email was never verified, without linking Google to it', async () => {
		const account = await createAccount({ role: 'seller', prefix: 'unverified' });
		const userId = await setUserColumns(account.email, { emailVerified: false });

		const res = await tap(idToken({ email: account.email }));

		expect(res.status).toBe(401);
		expect(res.headers['set-cookie']).toBeUndefined();
		expect(await googleAccountsOf(userId)).toHaveLength(0);
		await signInSession(app, account);
	});

	it('refuses a token whose email Google has not verified, for a new and for an existing email', async () => {
		const account = await createAccount({ role: 'seller', prefix: 'claim' });
		const fresh = uniqueEmail('claim');

		const existing = await tap(idToken({ email: account.email, email_verified: false }));
		const newcomer = await tap(idToken({ email: fresh, email_verified: false }));

		for (const res of [existing, newcomer]) {
			expect(res.status).toBe(403);
			expect(res.body.code).toBe('GOOGLE_EMAIL_UNVERIFIED');
			expect(res.headers['set-cookie']).toBeUndefined();
		}
		expect(await findUser({ email: fresh })).toBeNull();
		expect(await googleAccountsOf((await findUser({ email: account.email }))._id)).toHaveLength(0);
	});

	it('refuses a token for another audience and one signed with a key Google never published', async () => {
		const email = uniqueEmail('forged');

		const wrongAudience = await tap(idToken({ email, aud: 'someone-else.apps.googleusercontent.com' }));
		const forged = await tap(idToken({ email }, { signWith: strangerKey }));

		expect(wrongAudience.status).toBe(400);
		expect(forged.status).toBe(400);
		expect(await countRows('user', { email })).toBe(0);
	});

	it('refuses a banned staff account a session', async () => {
		const account = await createAccount({ role: 'seller', prefix: 'tapbanned' });
		await setUserColumns(account.email, { banned: true, banReason: 'test' });

		const res = await tap(idToken({ email: account.email }));

		expect(res.status).toBe(403);
		expect(res.body.code).toBe('BANNED_USER');
		expect(res.headers['set-cookie']).toBeUndefined();
	});
});
