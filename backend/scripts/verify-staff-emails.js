/**
 * One-time backfill: mark the email of every admin and seller account as verified.
 *
 * Why. Staff may sign in with an email code or Google as well as a password. Better
 * Auth deletes the password and the sessions of an account whose email is not
 * verified when a code proves control of that address, so the sign-in code flow
 * refuses an unverified staff account outright, and Google cannot link to one.
 * Accounts made before this change were stored unverified. Accounts made by an admin
 * from now on are stored verified: the admin typing the address is the proof.
 *
 * What it means. Whoever controls the mailbox of a verified staff address can sign in
 * as that staff member. Read the dry-run list first: a placeholder or mistyped
 * address would hand the account to whoever owns that mailbox. Fix such an address
 * before applying, or leave that account unverified (it keeps its password).
 *
 * Dry-run by default: prints each staff username with its role and a masked email
 * (first character, local-part length, domain: `t***(7)@gmail.com`; never the full
 * address) and whether it is verified, and changes nothing. `--apply` needs a choice of
 * who: `--only=<username,...>` verifies just those accounts, `--all` every unverified
 * one, so a list that was read and not fully trusted cannot be applied wholesale.
 *
 * Run on the server, where the database URL is already set:
 *   docker exec <backend container> node scripts/verify-staff-emails.js
 *   docker exec <backend container> node scripts/verify-staff-emails.js --apply --only=alice,bob
 *   docker exec <backend container> node scripts/verify-staff-emails.js --apply --all
 */
require('dotenv').config({ quiet: true });

// A store has a handful of staff; this only has to exceed that.
const STAFF_LIMIT = 1000;

/** `t***(7)@gmail.com`: enough to recognise a typo or a placeholder, not enough to use the address. */
const maskEmail = (email) => {
	const at = typeof email === 'string' ? email.lastIndexOf('@') : -1;
	if (at < 1 || at === email.length - 1) return '(not an email address)';
	return `${email[0]}***(${at})@${email.slice(at + 1).toLowerCase()}`;
};

function parseArgs(argv) {
	const apply = argv.includes('--apply');
	const all = argv.includes('--all');
	const onlyArg = argv.find((arg) => arg.startsWith('--only='));
	const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((name) => name.trim()).filter(Boolean) : null;
	if (onlyArg && only.length === 0) throw new Error('--only needs at least one username');
	if (all && only) throw new Error('use --only or --all, not both');
	if (apply && !all && !only) throw new Error('--apply needs --only=<username,...> or --all');
	return { apply, all, only };
}

async function main(argv) {
	const { apply, only } = parseArgs(argv);
	const { auth, closeAuth } = require('../lib/auth');
	const { isStaffRole } = require('../lib/auth-guards');
	try {
		const context = await auth.$context;
		// Roles are a comma list ('admin,seller'), so the query only narrows and isStaffRole decides.
		const candidates = await context.adapter.findMany({
			model: 'user',
			where: [
				{ field: 'role', operator: 'contains', value: 'admin', connector: 'OR' },
				{ field: 'role', operator: 'contains', value: 'seller', connector: 'OR' }
			],
			limit: STAFF_LIMIT
		});
		const staff = candidates.filter((user) => isStaffRole(user.role));

		if (only) {
			const known = new Set(staff.map((user) => user.username));
			const unknown = only.filter((name) => !known.has(name));
			if (unknown.length > 0) throw new Error(`not a staff username: ${unknown.join(', ')}`);
		}

		console.log(`--- staff email verification (${apply ? 'APPLY' : 'dry-run'}) ---`);
		for (const user of staff) {
			const state = user.emailVerified === true ? 'verified' : 'UNVERIFIED';
			console.log(`  ${String(user.username).padEnd(24)} ${String(user.role).padEnd(12)} ${state.padEnd(10)} ${maskEmail(user.email)}`);
		}

		const pending = staff.filter((user) => user.emailVerified !== true && (!only || only.includes(user.username)));
		console.log(`\nstaff accounts:    ${staff.length}`);
		console.log(`to verify:         ${pending.length}`);

		if (!apply) {
			console.log('\nNo data was modified. Re-run with --apply --only=<username,...> (or --all) after reading the list above.');
			return;
		}

		for (const user of pending) {
			// eslint-disable-next-line no-await-in-loop
			await context.adapter.update({
				model: 'user',
				where: [{ field: 'id', value: user.id }],
				update: { emailVerified: true, updatedAt: new Date() }
			});
		}
		console.log(`\nVerified ${pending.length} staff account(s).`);
	} finally {
		await closeAuth();
	}
}

if (require.main === module) {
	main(process.argv.slice(2)).catch((error) => {
		console.error('verify-staff-emails failed:', error.message);
		process.exit(1);
	});
}
