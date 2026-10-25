const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { createAccount } = require('../helpers/factories');
const { authPost, uniqueEmail, sendCode, signInWithCode, captureMail, codeOf, setUserColumns } = require('./auth-test-kit');

// The login form sends an identifier containing "@" to the email endpoint and anything
// else to the username endpoint; both must accept the same staff account.
describe('staff sign-in by email or username', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const byEmail = (email, password) => authPost(app, '/sign-in/email', { email, password });
	const byUsername = (username, password) => authPost(app, '/sign-in/username', { username, password });

	it.each(['seller', 'admin'])('signs a %s in with either identifier and the same password', async (role) => {
		const account = await createAccount({ role, prefix: role });

		const email = await byEmail(account.email, account.password);
		const username = await byUsername(account.username, account.password);

		for (const res of [email, username]) {
			expect(res.status).toBe(200);
			const session = await request(app).get('/api/auth/get-session').set('Cookie', res.headers['set-cookie']);
			expect(session.body.user).toMatchObject({ email: account.email, role });
		}
	});

	it('ignores the case of an email and of a username', async () => {
		const account = await createAccount({ role: 'seller', prefix: 'case' });

		expect((await byEmail(account.email.toUpperCase(), account.password)).status).toBe(200);
		expect((await byUsername(account.username.toUpperCase(), account.password)).status).toBe(200);
	});

	it('refuses a wrong password on both endpoints', async () => {
		const account = await createAccount({ role: 'seller', prefix: 'wrong' });

		expect((await byEmail(account.email, 'not-the-password-1')).status).toBe(401);
		expect((await byUsername(account.username, 'not-the-password-1')).status).toBe(401);
	});

	it('still signs in a staff account whose email is unverified (a password needs no verified email)', async () => {
		const account = await createAccount({ role: 'seller', prefix: 'legacy' });
		await setUserColumns(account.email, { emailVerified: false });

		expect((await byEmail(account.email, account.password)).status).toBe(200);
		expect((await byUsername(account.username, account.password)).status).toBe(200);
	});

	it('gives a customer, who has no password, no way in through either endpoint', async () => {
		const sent = captureMail();
		const email = uniqueEmail();
		await sendCode(app, email);
		const registered = await signInWithCode(app, email, codeOf(sent[0]));
		expect(registered.status).toBe(200);
		const customer = await request(app).get('/api/auth/get-session').set('Cookie', registered.headers['set-cookie']);

		expect((await byEmail(email, 'Str0ngPassw0rd!')).status).toBe(401);
		expect((await byUsername(customer.body.user.username, 'Str0ngPassw0rd!')).status).toBe(401);
	});
});
