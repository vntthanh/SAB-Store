/**
 * Copies the MongoDB store into an empty PostgreSQL database: business data,
 * users, login accounts, live sessions and the JWT signing keys. Ids become
 * UUIDv7 through objectIdToUuidV7, the map the backend applies to every legacy
 * id it still meets.
 *
 * DRY RUN BY DEFAULT: everything is written and verified inside one transaction
 * that is then rolled back. `--apply` commits it, and only when every check
 * passed. The target must be empty; this never deletes anything.
 *
 *   MONGODB_URI=<source>  DATABASE_URL=<target>  node scripts/migrate-mongo-to-postgres.js [--apply] [--report <file>]
 *
 * The source must be quiet: a restored copy, or production with its backend
 * stopped. Run it before the PostgreSQL backend first boots, or the admin seed
 * makes the target non-empty. Pending stock movements are not queued here; the
 * backend's sweeper picks them up once it runs.
 *
 * Output and `--report` (JSON) hold counts and totals. Problem lines name
 * collections, ids and fields, never personal data, hashes or tokens; the one
 * exception is the restore's own order-total check, which names the order code,
 * as it does for an admin restoring a backup.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { MongoClient } = require('mongodb');
const { backendName } = require('../data/backend-name');
const { connectDB, closeDB } = require('../lib/database');
const ErrorLogger = require('../utils/errorLogger');
const { readSource } = require('./migrate-mongo/source');
const { migrate } = require('./migrate-mongo/load');

function parseArgs(argv) {
	const args = { apply: false, report: null };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--apply') args.apply = true;
		else if (argv[i] === '--report' && argv[i + 1]) args.report = argv[(i += 1)];
		else throw new Error(`Unknown argument: ${argv[i]}`);
	}
	return args;
}

async function readMongo(uri) {
	const client = new MongoClient(uri);
	try {
		await client.connect();
		return await readSource(client.db());
	} finally {
		await client.close();
	}
}

function print(result) {
	const { report } = result;
	console.log(`Mode: ${report.mode}`);
	console.log('Legacy repairs:', report.repairs);
	console.log('Auth:', report.auth);
	if (report.counts) console.log('Rows:', report.counts);
	if (report.totals) console.log('Totals:', report.totals);
	if (report.pendingMovements !== undefined) console.log(`Pending stock movements: ${report.pendingMovements}`);
	for (const problem of result.problems) console.log(`PROBLEM: ${problem}`);
	if (!result.ok) console.log('Nothing was written.');
	else if (result.committed) console.log('Committed.');
	else console.log('Every check passed. Dry run: nothing was written. Re-run with --apply to commit.');
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (backendName !== 'postgres') throw new Error('DATA_BACKEND must be postgres (the target) for this script');
	if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI (the source) is not set');

	const source = await readMongo(process.env.MONGODB_URI);
	await connectDB();
	let result;
	try {
		result = await migrate(source, { apply: args.apply });
	} finally {
		await closeDB();
	}

	print(result);
	if (args.report) {
		fs.writeFileSync(args.report, `${JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
		// `mode` applies only when the file is created; an existing file keeps its own.
		fs.chmodSync(args.report, 0o600);
	}
	return result.ok ? 0 : 1;
}

main().then(
	(code) => { process.exitCode = code; },
	(err) => {
		ErrorLogger.logCritical('Migration failed', err, { stage: 'migrate-mongo-to-postgres' });
		process.exitCode = 1;
	}
);
