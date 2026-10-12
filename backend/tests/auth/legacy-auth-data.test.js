/**
 * Production holds users, credential accounts, sessions and JWKS rows written
 * by an older Better Auth release. These tests insert documents in that exact
 * on-disk shape (ids and user references as ObjectId, scrypt password hash,
 * bare-hex encrypted JWKS private key; the hash and the key were produced by
 * the old package itself) and require the current server to keep honouring them.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const { ObjectId } = require('mongodb');
const http = require('http');
const { buildTestApp } = require('../helpers/app');
const { clearAppModules } = require('../helpers/require-cache');
const { trackServer } = require('../helpers/servers');

// Produced by the previous Better Auth release with the test JWT_SECRET.
const LEGACY_PASSWORD = 'legacy-Passw0rd!';
const LEGACY_PASSWORD_HASH =
	'e652cfcee9fc8e624fe526a0ff2c761d:f773c739d1a0c3e580c097f5a7760af14032a18cdcbf193c763cfdf2bc7511d31788cae5e01038a5e6c51f48e2e81ad1eb1128c924578e805b5c8a4a10b8cfc2';
const LEGACY_JWK_PUBLIC = '{"crv":"Ed25519","x":"b33s16cqFTf1vrL2NOKX0_C6yvC7Fhvs4Hwi7hjgnT4","kty":"OKP"}';
const LEGACY_JWK_PRIVATE_ENCRYPTED =
	'"3069d92dd5bdc239b302945830b4d950bd3b18b984bd03a0922f6c4c0bf05a88b2d9d7fc695fbb25837c670f2b0fbf302dc94806d20c35f952d6b4c334095795c6e1cb4f46b85e6a89950d5aedd01d64cb25a97ec6f45105361c0fec65e2b6c06288be12329efec19c92049558630c7535d72a95cafebcd7b2436fd2aeb6c1d66937325992365eeec63cd08e825c935ab18a9cdc16f29a1a3af34a04d2917f8ac9f6400f2e6b0701f7"';

const SECRET = process.env.JWT_SECRET;

describe('data written by the previous Better Auth release', () => {
	let app;
	let db;
	const userId = new ObjectId();
	const token = crypto.randomBytes(16).toString('hex');
	const email = 'legacy-admin@test.local';

	beforeAll(() => {
		app = buildTestApp();
		db = mongoose.connection.db;
	});

	// The suite wipes the mongoose-registered collections after each test, so the
	// data is re-seeded. jwks, session and account have no mongoose model and must be
	// cleared here, and so is `user` when no loaded module registers its model (a run
	// with the data layer on Postgres), so the fixed _id below is never inserted twice.
	beforeEach(async () => {
		const now = new Date();
		await Promise.all(['jwks', 'session', 'account', 'user'].map((name) => db.collection(name).deleteMany({})));

		await db.collection('user').insertOne({
			_id: userId,
			name: 'Legacy Admin',
			email,
			emailVerified: false,
			image: null,
			createdAt: now,
			updatedAt: now,
			username: 'legacy_admin',
			displayUsername: 'Legacy_Admin',
			role: 'admin',
		});
		await db.collection('account').insertOne({
			_id: new ObjectId(),
			accountId: userId.toString(),
			providerId: 'credential',
			userId,
			password: LEGACY_PASSWORD_HASH,
			createdAt: now,
			updatedAt: now,
		});
		await db.collection('session').insertOne({
			_id: new ObjectId(),
			expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
			token,
			createdAt: now,
			updatedAt: now,
			ipAddress: '127.0.0.1',
			userAgent: 'legacy',
			userId,
		});
		await db.collection('jwks').insertOne({
			_id: new ObjectId(),
			publicKey: LEGACY_JWK_PUBLIC,
			privateKey: LEGACY_JWK_PRIVATE_ENCRYPTED,
			createdAt: now,
		});
	});

	// Cookie value is `<token>.<base64 HMAC-SHA256(secret, token)>`, URL-encoded.
	function legacySessionCookie(name = 'better-auth.session_token') {
		const signature = crypto.createHmac('sha256', SECRET).update(token).digest('base64');
		return `${name}=${encodeURIComponent(`${token}.${signature}`)}`;
	}

	it('keeps an existing session valid and resolves the role', async () => {
		const res = await request(app).get('/api/auth/get-session').set('Cookie', legacySessionCookie());

		expect(res.status).toBe(200);
		expect(res.body.user).toMatchObject({ id: userId.toString(), email, role: 'admin', username: 'legacy_admin' });
		expect(res.body.session.userId).toBe(userId.toString());
	});

	it('authorises an admin-only route with that session', async () => {
		const res = await request(app).get('/api/admin/orders').set('Cookie', legacySessionCookie());
		expect(res.status).toBe(200);
		expect((await request(app).get('/api/admin/orders')).status).toBe(401);
	});

	it('rejects the same cookie with a tampered signature', async () => {
		const forged = `better-auth.session_token=${encodeURIComponent(`${token}.${Buffer.alloc(32).toString('base64')}`)}`;
		const res = await request(app).get('/api/auth/get-session').set('Cookie', forged);
		expect(res.body).toBeNull();
	});

	it('signs the user in by email and by username with the old password hash', async () => {
		const byEmail = await request(app).post('/api/auth/sign-in/email').send({ email, password: LEGACY_PASSWORD });
		expect(byEmail.status).toBe(200);

		const byUsername = await request(app)
			.post('/api/auth/sign-in/username')
			.send({ username: 'Legacy_Admin', password: LEGACY_PASSWORD });
		expect(byUsername.status).toBe(200);

		const wrong = await request(app).post('/api/auth/sign-in/email').send({ email, password: 'not-the-password-1' });
		expect(wrong.status).toBe(401);
	});

	it('signs a JWT with the existing encrypted JWKS key instead of minting a new one', async () => {
		const res = await request(app).get('/api/auth/token').set('Cookie', legacySessionCookie());
		expect(res.status).toBe(200);

		const [header, payload, signature] = res.body.token.split('.');
		const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
		expect(claims).toMatchObject({ id: userId.toString(), email, role: 'admin', username: 'legacy_admin' });

		const publicKey = crypto.createPublicKey({ key: JSON.parse(LEGACY_JWK_PUBLIC), format: 'jwk' });
		const valid = crypto.verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'));
		expect(valid).toBe(true);

		expect(await db.collection('jwks').countDocuments({})).toBe(1);
		const jwks = await request(app).get('/api/auth/jwks');
		expect(jwks.body.keys).toHaveLength(1);
		expect(jwks.body.keys[0].x).toBe(JSON.parse(LEGACY_JWK_PUBLIC).x);
	});

	// Must stay the last block: clearAppModules closes the outer app's auth client.
	// Production serves over https, where the cookie carries the __Secure- prefix.
	describe('behind an https base URL', () => {
		const originalBaseUrl = process.env.BASE_URL;
		let httpsApp;

		beforeAll(async () => {
			process.env.BASE_URL = 'https://shop.example.test';
			await clearAppModules();
			const { createApp } = require('../../server');
			httpsApp = trackServer(http.createServer(createApp()).listen(0));
		});

		afterAll(async () => {
			if (originalBaseUrl === undefined) delete process.env.BASE_URL;
		else process.env.BASE_URL = originalBaseUrl;
			await clearAppModules();
		});

		it('honours the __Secure- session cookie and ignores the unprefixed name', async () => {
			const secure = await request(httpsApp)
				.get('/api/auth/get-session')
				.set('Cookie', legacySessionCookie('__Secure-better-auth.session_token'));
			expect(secure.status).toBe(200);
			expect(secure.body.user).toMatchObject({ id: userId.toString(), role: 'admin' });

			const plain = await request(httpsApp).get('/api/auth/get-session').set('Cookie', legacySessionCookie());
			expect(plain.body).toBeNull();
		});

		it('issues the __Secure- cookie on sign-in', async () => {
			const res = await request(httpsApp).post('/api/auth/sign-in/email').send({ email, password: LEGACY_PASSWORD });
			expect(res.status).toBe(200);
			expect(res.headers['set-cookie'].some((c) => c.startsWith('__Secure-better-auth.session_token='))).toBe(true);
		});
	});
});
