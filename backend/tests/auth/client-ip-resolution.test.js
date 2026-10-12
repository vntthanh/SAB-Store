/**
 * Better Auth keys its rate limiter on the client IP it resolves from
 * X-Forwarded-For. It only accepts a multi-hop header when told which hops to
 * trust; otherwise every request lands in one shared bucket. The session row
 * records the same resolved address, which makes it observable here.
 */
const request = require('supertest');
const { buildTestApp } = require('../helpers/app');
const { createAccount } = require('../helpers/factories');
const { findAuthRows } = require('../helpers/db');

describe('client IP resolution behind the proxy chain', () => {
	let app;

	beforeAll(() => {
		app = buildTestApp();
	});

	async function signInVia(forwardedFor) {
		const { email, password } = await createAccount();

		const res = await request(app)
			.post('/api/auth/sign-in/email')
			.set('X-Forwarded-For', forwardedFor)
			.send({ email, password });
		expect(res.status).toBe(200);
		// The mongo store keeps sessions across tests, so take the one just written.
		return (await findAuthRows('session')).at(-1);
	}

	it('takes the client from a single-hop header', async () => {
		const session = await signInVia('203.0.113.7');
		expect(session.ipAddress).toBe('203.0.113.7');
	});

	it('strips trusted proxy hops from the right of a multi-hop header', async () => {
		const session = await signInVia('203.0.113.7, 10.0.0.9');
		expect(session.ipAddress).toBe('203.0.113.7');
	});

	it.each(['127.0.0.1', '::1'])('strips a loopback proxy hop (%s)', async (hop) => {
		const session = await signInVia(`203.0.113.7, ${hop}`);
		expect(session.ipAddress).toBe('203.0.113.7');
	});

	it('stops at an untrusted hop on the right', async () => {
		const session = await signInVia('203.0.113.7, 198.51.100.1');
		expect(session.ipAddress).toBe('198.51.100.1');
	});

	it('ignores a client-forged leftmost entry', async () => {
		const session = await signInVia('6.6.6.6, 203.0.113.7, 10.0.0.9');
		expect(session.ipAddress).toBe('203.0.113.7');
	});
});
