/**
 * What the database itself guarantees about login identities, and the id shape
 * Better Auth writes into native uuid columns.
 */
const { Client } = require('pg');
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { createAccount } = require('../helpers/factories');
const { findAuthRows, insertRawUser } = require('../helpers/db');
const { POOL_OPTIONS } = require('../helpers/postgres');

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = '23505';

describe('login identities on postgres', () => {
	let pg;

	beforeAll(async () => {
		pg = new Client({ connectionString: process.env.DATABASE_URL, options: POOL_OPTIONS });
		await pg.connect();
	});

	afterAll(async () => {
		await pg.end();
	});

	it('gives a new user, account and session a UUIDv7 id', async () => {
		const app = buildTestApp();
		const { email, password } = await createAccount();
		const signIn = await request(app).post('/api/auth/sign-in/email').send({ email, password });
		expect(signIn.status).toBe(200);

		for (const table of ['user', 'account', 'session']) {
			const rows = await findAuthRows(table);
			expect(rows, table).toHaveLength(1);
			expect(rows[0]._id, table).toMatch(UUID_V7);
		}
		const [account] = await findAuthRows('account');
		const [user] = await findAuthRows('user');
		const [session] = await findAuthRows('session');
		expect(account.userId).toBe(user._id);
		expect(session.userId).toBe(user._id);
		expect(account.accountId).toBe(user._id);
	});

	it('keeps the session bearer token apart from the row id, and long and random', async () => {
		const app = buildTestApp();
		const { email, password } = await createAccount();
		await request(app).post('/api/auth/sign-in/email').send({ email, password }).expect(200);

		const [session] = await findAuthRows('session');
		expect(session.token).not.toBe(session._id);
		expect(session.token).not.toMatch(UUID_ANY);
		expect(session.token.length).toBeGreaterThanOrEqual(32);
	});

	it('gives the signing key a UUIDv7 id', async () => {
		const app = buildTestApp();
		const { email, password } = await createAccount();
		const signIn = await request(app).post('/api/auth/sign-in/email').send({ email, password });
		// The first authenticated request mints the key.
		await request(app).get('/api/auth/get-session').set('Cookie', signIn.headers['set-cookie']).expect(200);

		const keys = await findAuthRows('jwks');
		expect(keys).toHaveLength(1);
		expect(keys[0]._id).toMatch(UUID_V7);
	});

	it('rejects a second user with the same username', async () => {
		await insertRawUser({ email: 'first@test.local', username: 'taken_name' });

		await expect(insertRawUser({ email: 'second@test.local', username: 'taken_name' }))
			.rejects.toMatchObject({ code: UNIQUE_VIOLATION });
	});

	it('rejects a second account for the same provider and account id', async () => {
		const first = await insertRawUser({ email: 'owner-a@test.local', username: 'owner_a' });
		const second = await insertRawUser({ email: 'owner-b@test.local', username: 'owner_b' });
		const insertAccount = (userId) => pg.query(
			`INSERT INTO "account" ("id", "accountId", "providerId", "userId", "updatedAt")
			 VALUES (gen_random_uuid(), 'shared-account-id', 'credential', $1::uuid, now())`,
			[userId]
		);

		await insertAccount(first._id);

		await expect(insertAccount(second._id)).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
	});
});
