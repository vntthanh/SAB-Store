const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const { createAccount } = require('../helpers/factories');
const { findAuthRows, findUser } = require('../helpers/db');
const { setUserColumns } = require('../auth/auth-test-kit');

const run = promisify(execFile);
const BACKEND = path.resolve(__dirname, '../..');

// The command line, not an exported function: connecting and the exit code are what an operator relies on.
const runScript = (...args) => run(process.execPath, [path.join('scripts', 'verify-staff-emails.js'), ...args], {
	cwd: BACKEND,
	env: process.env,
	timeout: 60000
});

describe('verify-staff-emails', () => {
	let staleSeller;
	let verifiedAdmin;
	let customer;

	beforeEach(async () => {
		verifiedAdmin = await createAccount({ role: 'admin', prefix: 'okadmin' });
		staleSeller = await createAccount({ role: 'seller', prefix: 'stale' });
		await setUserColumns(staleSeller.email, { emailVerified: false });
		// An account with no staff role is never touched.
		customer = await createAccount({ prefix: 'shopper' });
	});

	const maskOf = (account) => {
		const [local, domain] = account.email.split('@');
		return `${local[0]}***(${local.length})@${domain}`;
	};

	it('by default lists staff by username, role and masked email only, and changes nothing', async () => {
		const before = await findAuthRows('user');

		const { stdout } = await runScript();

		expect(stdout).toContain(staleSeller.username);
		expect(stdout).toContain(verifiedAdmin.username);
		expect(stdout).toContain(maskOf(staleSeller));
		expect(stdout).toContain(maskOf(verifiedAdmin));
		expect(stdout).toMatch(/to verify:\s+1/);
		for (const account of [staleSeller, verifiedAdmin, customer]) {
			expect(stdout).not.toContain(account.email);
			expect(stdout).not.toContain(account.email.split('@')[0]);
		}
		expect(stdout).not.toContain(customer.username);
		expect(stdout).toContain('No data was modified.');
		expect(await findAuthRows('user')).toEqual(before);
	});

	it('lists an account whose role is a comma list as staff', async () => {
		const both = await createAccount({ role: 'admin,seller', prefix: 'both' });
		await setUserColumns(both.email, { emailVerified: false });

		const { stdout } = await runScript();

		expect(stdout).toContain(both.username);
		expect(stdout).toMatch(/to verify:\s+2/);
	});

	it('refuses --apply without --only or --all, and writes nothing', async () => {
		await expect(runScript('--apply')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--apply needs') });

		expect((await findUser({ email: staleSeller.email })).emailVerified).toBe(false);
	});

	it('with --apply --only verifies the listed accounts and nobody else', async () => {
		const other = await createAccount({ role: 'seller', prefix: 'other' });
		await setUserColumns(other.email, { emailVerified: false });

		const { stdout } = await runScript('--apply', `--only=${staleSeller.username}`);

		expect(stdout).toContain('Verified 1 staff account(s).');
		expect((await findUser({ email: staleSeller.email })).emailVerified).toBe(true);
		expect((await findUser({ email: other.email })).emailVerified).toBe(false);
		expect((await findUser({ email: customer.email })).emailVerified).toBe(false);
	});

	it('refuses an --only name that is not a staff username, and writes nothing', async () => {
		await expect(runScript('--apply', `--only=${staleSeller.username},${customer.username}`)).rejects.toMatchObject({
			stderr: expect.stringContaining('not a staff username')
		});

		expect((await findUser({ email: staleSeller.email })).emailVerified).toBe(false);
	});

	it('with --apply --all verifies every unverified staff account and no customer', async () => {
		const { stdout } = await runScript('--apply', '--all');

		expect(stdout).toContain('Verified 1 staff account(s).');
		expect((await findUser({ email: staleSeller.email })).emailVerified).toBe(true);
		expect((await findUser({ email: customer.email })).emailVerified).toBe(false);
	});
});
