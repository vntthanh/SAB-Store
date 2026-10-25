/**
 * The Sellers page edits another user through Better Auth's admin update endpoint.
 * The plugin decides who may call it; the guard in front of it limits what the body
 * may change to the two fields the form edits.
 */
const { buildTestApp } = require('../helpers/app');
const { createAccount, signInSession, makeAdminSession } = require('../helpers/factories');
const { findUser } = require('../helpers/db');
const { authPost } = require('./auth-test-kit');

describe('admin update-user', () => {
	let app;
	let admin;
	let seller;
	let sellerId;

	beforeAll(() => {
		app = buildTestApp();
	});

	beforeEach(async () => {
		admin = await makeAdminSession(app);
		seller = await createAccount({ role: 'seller', prefix: 'edited' });
		sellerId = String((await findUser({ email: seller.email }))._id);
	});

	const update = (data, { cookies = admin.cookies, userId = sellerId } = {}) => authPost(app, '/admin/update-user', { userId, data }, { cookies });

	it('lets an admin change a seller name and username, and leaves the admin alone', async () => {
		const adminBefore = await findUser({ email: admin.email });

		const res = await update({ name: '  Renamed Seller ', username: 'Renamed_Seller' });

		expect(res.status).toBe(200);
		const stored = await findUser({ email: seller.email });
		expect(stored.name).toBe('Renamed Seller');
		expect(stored.username).toBe('renamed_seller');
		expect(stored.displayUsername).toBe('Renamed_Seller');
		expect(stored.role).toBe('seller');
		const adminAfter = await findUser({ email: admin.email });
		expect(adminAfter.name).toBe(adminBefore.name);
		expect(adminAfter.username).toBe(adminBefore.username);
		// The renamed seller signs in by the new name.
		await signInSession(app, { email: seller.email, password: seller.password });
	});

	it('accepts the current username next to a new name', async () => {
		const res = await update({ name: 'Only The Name', username: seller.username });

		expect(res.status).toBe(200);
		const stored = await findUser({ email: seller.email });
		expect(stored.name).toBe('Only The Name');
		expect(stored.username).toBe(seller.username);
	});

	it('refuses a username that another user, the calling admin included, already holds', async () => {
		const other = await createAccount({ role: 'seller', prefix: 'holder' });

		const taken = await update({ username: other.username });
		const adminName = await update({ username: admin.username });

		expect(taken.status).toBe(400);
		expect(adminName.status).toBe(400);
		expect((await findUser({ email: seller.email })).username).toBe(seller.username);
	});

	it.each([
		['a customer', async () => signInSession(app, await createAccount({ prefix: 'shopper' }))],
		['a seller', async () => signInSession(app, await createAccount({ role: 'seller', prefix: 'peer' }))]
	])('answers 403 to %s', async (_label, signIn) => {
		const cookies = await signIn();

		const res = await update({ name: 'Hijacked' }, { cookies });

		expect(res.status).toBe(403);
		expect((await findUser({ email: seller.email })).name).not.toBe('Hijacked');
	});

	it('answers an anonymous caller, a customer and a seller alike whether or not the username exists', async () => {
		const other = await createAccount({ role: 'seller', prefix: 'holder' });
		const customerCookies = await signInSession(app, await createAccount({ prefix: 'shopper' }));
		const sellerCookies = await signInSession(app, await createAccount({ role: 'seller', prefix: 'peer' }));
		const probe = (username, cookies) => update({ username }, { cookies: cookies ?? '' });

		for (const [cookies, status] of [[undefined, 401], [customerCookies, 403], [sellerCookies, 403]]) {
			// eslint-disable-next-line no-await-in-loop
			const existing = await probe(other.username, cookies);
			// eslint-disable-next-line no-await-in-loop
			const missing = await probe(`nobody_${Date.now()}`, cookies);

			expect(existing.status).toBe(status);
			expect(missing.status).toBe(status);
			expect(existing.body).toEqual(missing.body);
			expect(existing.body.code).not.toBe('USERNAME_IS_ALREADY_TAKEN');
		}
	});

	it('answers an anonymous caller, a customer and a seller alike whether or not the username exists', async () => {
		const other = await createAccount({ role: 'seller', prefix: 'holder' });
		const customerCookies = await signInSession(app, await createAccount({ prefix: 'shopper' }));
		const sellerCookies = await signInSession(app, await createAccount({ role: 'seller', prefix: 'peer' }));

		for (const [cookies, status] of [['', 401], [customerCookies, 403], [sellerCookies, 403]]) {
			// eslint-disable-next-line no-await-in-loop
			const existing = await update({ username: other.username }, { cookies });
			// eslint-disable-next-line no-await-in-loop
			const missing = await update({ username: `nobody_${Date.now()}` }, { cookies });

			expect(existing.status).toBe(status);
			expect(missing.status).toBe(status);
			expect(existing.body).toEqual(missing.body);
			expect(existing.body.code).not.toBe('USERNAME_IS_ALREADY_TAKEN');
		}
	});

	it.each([
		['role', { role: 'admin' }],
		['email', { email: 'taken-over@test.local' }],
		['emailVerified', { emailVerified: false }],
		['banned', { banned: true }],
		['a field next to a permitted one', { name: 'Fine', role: 'admin' }],
		['displayUsername', { displayUsername: 'Other' }],
		['nothing', {}]
	])('answers 400 to data with %s, and changes nothing', async (_label, data) => {
		const before = await findUser({ email: seller.email });

		const res = await update(data);

		expect(res.status).toBe(400);
		const after = await findUser({ email: seller.email });
		expect(after.role).toBe('seller');
		expect(after.email).toBe(before.email);
		expect(after.name).toBe(before.name);
		expect(after.emailVerified).toBe(before.emailVerified);
	});

	it('answers 400 to a blank name or a non-string username', async () => {
		expect((await update({ name: '   ' })).status).toBe(400);
		expect((await update({ username: { $ne: null } })).status).toBe(400);
	});
});
