/**
 * The admin Sellers page drives Better Auth's admin plugin straight from the
 * browser (create / list / set-password / remove). Authorisation lives in the
 * plugin, so these tests pin the contract the page relies on: an admin session
 * can manage sellers, nobody else can, and a request body cannot smuggle a role,
 * email or name past the plugin's permission checks.
 */
const { randomUUID } = require('crypto');
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { makeAdminSession } = require('../helpers/factories');
const { auth } = require('../../lib/auth');
const { findUser, countRows } = require('../helpers/db');

const PASSWORD = 'Str0ngPassw0rd!';

describe('admin user management through the auth handler', () => {
	let app;
	let admin;

	beforeAll(() => {
		app = buildTestApp();
	});

	// The suite wipes every collection after each test, so the admin is per test.
	beforeEach(async () => {
		admin = await makeAdminSession(app);
	});

	const asAdmin = (req) => req.set('Cookie', admin.cookies);

	const sellerBody = (overrides = {}) => {
		const id = randomUUID().slice(0, 8);
		return {
			email: `seller-${id}@test.local`,
			password: PASSWORD,
			name: `Seller ${id}`,
			role: 'seller',
			data: { username: `Seller_${id}` },
			...overrides,
		};
	};

	async function createSeller(overrides) {
		const body = sellerBody(overrides);
		const res = await asAdmin(request(app).post('/api/auth/admin/create-user')).send(body);
		expect(res.status).toBe(200);
		return { body, user: res.body.user };
	}

	async function sellerSession(email, password = PASSWORD) {
		const res = await request(app).post('/api/auth/sign-in/email').send({ email, password });
		expect(res.status).toBe(200);
		return res.headers['set-cookie'];
	}

	it('lets an admin create a seller who can then sign in by username', async () => {
		const { body, user } = await createSeller();

		expect(user.role).toBe('seller');
		const stored = await findUser({ email: body.email });
		expect(stored.role).toBe('seller');
		// Usernames are stored lower-cased, which is also how sign-in looks them up.
		expect(stored.username).toBe(body.data.username.toLowerCase());

		const signIn = await request(app)
			.post('/api/auth/sign-in/username')
			.send({ username: body.data.username, password: PASSWORD });
		expect(signIn.status).toBe(200);
	});

	it('refuses a duplicate username on seller creation', async () => {
		const first = await createSeller();
		const res = await asAdmin(request(app).post('/api/auth/admin/create-user')).send(
			sellerBody({ data: { username: first.body.data.username.toUpperCase() } })
		);
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('USERNAME_IS_ALREADY_TAKEN');
		expect(await countRows('user', { username: first.body.data.username.toLowerCase() })).toBe(1);
	});

	it('rejects an anonymous caller', async () => {
		const res = await request(app).post('/api/auth/admin/create-user').send(sellerBody());
		expect(res.status).toBe(401);
	});

	it('rejects a seller session, with or without a role in the body', async () => {
		const { body } = await createSeller();
		const cookies = await sellerSession(body.email);
		const usersBefore = await countRows('user', {});

		const escalate = await request(app)
			.post('/api/auth/admin/create-user')
			.set('Cookie', cookies)
			.send(sellerBody({ role: 'admin' }));
		expect(escalate.status).toBe(403);

		const plain = await request(app)
			.post('/api/auth/admin/create-user')
			.set('Cookie', cookies)
			.send(sellerBody({ role: undefined }));
		expect(plain.status).toBe(403);

		const list = await request(app).get('/api/auth/admin/list-users').set('Cookie', cookies);
		expect(list.status).toBe(403);
		expect(await countRows('user', {})).toBe(usersBefore);
	});

	it('does not let data override the role, email or name sent at the top level', async () => {
		const body = sellerBody();
		const evilEmail = `evil-${randomUUID().slice(0, 8)}@test.local`;
		const res = await asAdmin(request(app).post('/api/auth/admin/create-user')).send({
			...body,
			data: { ...body.data, role: 'admin', email: evilEmail, name: 'Smuggled' },
		});

		expect(res.status).toBe(200);
		const stored = await findUser({ email: body.email });
		expect(stored).not.toBeNull();
		expect(stored.role).toBe('seller');
		expect(stored.name).toBe(body.name);
		expect(await findUser({ email: evilEmail })).toBeNull();
	});

	it('lists only sellers when the page filters by role', async () => {
		const { body } = await createSeller();

		const res = await asAdmin(request(app).get('/api/auth/admin/list-users')).query({
			filterField: 'role',
			filterValue: 'seller',
			filterOperator: 'eq',
		});

		expect(res.status).toBe(200);
		expect(res.body.users.length).toBeGreaterThan(0);
		expect(res.body.users.every((u) => u.role === 'seller')).toBe(true);
		expect(res.body.users.map((u) => u.email)).toContain(body.email);
	});

	it('lets an admin reset a seller password and revokes the old one', async () => {
		const { body, user } = await createSeller();
		const next = 'Zq9xK2mW4vB-new';

		const res = await asAdmin(request(app).post('/api/auth/admin/set-user-password')).send({
			userId: user.id,
			newPassword: next,
		});

		expect(res.status).toBe(200);
		expect((await request(app).post('/api/auth/sign-in/email').send({ email: body.email, password: next })).status).toBe(200);
		expect((await request(app).post('/api/auth/sign-in/email').send({ email: body.email, password: PASSWORD })).status).toBe(401);
	});

	it('refuses to let a seller reset another account password', async () => {
		const victim = await createSeller();
		const attacker = await createSeller();
		const cookies = await sellerSession(attacker.body.email);

		const res = await request(app)
			.post('/api/auth/admin/set-user-password')
			.set('Cookie', cookies)
			.send({ userId: victim.user.id, newPassword: 'Zq9xK2mW4vB-hijack' });

		expect(res.status).toBe(403);
		expect((await request(app).post('/api/auth/sign-in/email').send({ email: victim.body.email, password: PASSWORD })).status).toBe(200);
	});

	it('lets an admin remove a seller', async () => {
		const { body, user } = await createSeller();

		const res = await asAdmin(request(app).post('/api/auth/admin/remove-user')).send({ userId: user.id });

		expect(res.status).toBe(200);
		expect(await findUser({ email: body.email })).toBeNull();
	});

	describe('a user id that names nobody', () => {
		const ABSENT_UUID = '0191c8a0-0000-7000-8000-000000000000';
		const LEGACY_HEX_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
		const BY_BODY = [
			['set-user-password', (userId) => ({ userId, newPassword: 'Zq9xK2mW4vB-new' })],
			['ban-user', (userId) => ({ userId })],
			['set-role', (userId) => ({ userId, role: 'seller' })],
			['impersonate-user', (userId) => ({ userId })],
			['remove-user', (userId) => ({ userId })],
		];

		const postAs = (name, body) => asAdmin(request(app).post(`/api/auth/admin/${name}`)).send(body);
		const getUser = (id) => asAdmin(request(app).get('/api/auth/admin/get-user')).query({ id });

		// A malformed id is refused up front, so the caller gets a 4xx, never a store error.
		const MALFORMED_STATUS = 400;

		it.each(BY_BODY)('%s: a valid uuid that matches no user is a 404', async (name, body) => {
			const res = await postAs(name, body(ABSENT_UUID));
			expect(res.status).toBe(404);
			expect(res.body.code).toBe('USER_NOT_FOUND');
		});

		it.each(BY_BODY)('%s: a malformed id is a client error with no store detail', async (name, body) => {
			for (const id of ['abc', LEGACY_HEX_ID]) {
				const res = await postAs(name, body(id));
				expect(res.status, `${name} ${id}`).toBe(MALFORMED_STATUS);
				expect(JSON.stringify(res.body)).not.toMatch(/prisma|22P02|invalid input|uuid/i);
			}
		});

		it('get-user: absent uuid is a 404, a malformed id a client error', async () => {
			expect((await getUser(ABSENT_UUID)).status).toBe(404);
			for (const id of ['abc', LEGACY_HEX_ID]) {
				const res = await getUser(id);
				expect(res.status, id).toBe(MALFORMED_STATUS);
				expect(JSON.stringify(res.body)).not.toMatch(/prisma|22P02|invalid input|uuid/i);
			}
		});

		it('a malformed id changes nothing', async () => {
			const before = await countRows('user', {});
			await postAs('remove-user', { userId: 'abc' });
			expect(await countRows('user', {})).toBe(before);
		});
	});

	it('seeds the first admin the way init-database does, with no session', async () => {
		const id = randomUUID().slice(0, 8);
		const email = `seed-${id}@test.local`;

		await auth.api.createUser({
			body: {
				email,
				name: 'System Administrator',
				password: PASSWORD,
				role: 'admin',
				data: { username: `Seed_${id}`, displayUsername: 'Admin' },
			},
		});

		const stored = await findUser({ email });
		expect(stored.role).toBe('admin');
		expect(stored.username).toBe(`seed_${id}`);
		expect(stored.displayUsername).toBe('Admin');
		expect((await request(app).post('/api/auth/sign-in/email').send({ email, password: PASSWORD })).status).toBe(200);
	});
});
