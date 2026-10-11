/**
 * Embedded PostgreSQL for the test run, plus the helpers every layer shares.
 *
 * One real server (real locks, real collation) starts in the main process from
 * tests/global-setup.js. Each test file clones its own database from a template
 * that is built once per run, so files never share rows and creation costs a
 * file copy rather than a schema replay.
 *
 * Setting TEST_DATABASE_URL points the run at an existing server instead (for
 * example a docker postgres:17). Nothing is started or stopped then, but the run
 * creates and drops `sab_template_<pid>` and `test_<pid>` databases on it, so it
 * must be a throwaway server.
 */
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

// Identical to POSTGRES_INITDB_ARGS in production: the builtin provider gives the
// same case mapping and codepoint ordering on macOS, glibc and the musl image,
// where libc locales would each answer differently.
const INITDB_FLAGS = [
	'--encoding=UTF8',
	'--locale-provider=builtin',
	'--builtin-locale=C.UTF-8',
	'--locale=C.UTF-8',
];

// Durability is irrelevant for a throwaway data dir; fsync off is what makes
// per-file CREATE DATABASE and TRUNCATE cheap.
const SERVER_FLAGS = [
	'-c', 'timezone=UTC',
	'-c', 'fsync=off',
	'-c', 'synchronous_commit=off',
	'-c', 'full_page_writes=off',
	'-c', 'max_connections=100',
	'-c', 'shared_buffers=32MB',
];

// Every pg client must pin the session zone. Without it a session on a non-UTC
// default stores a timezone-less timestamp string at the wrong instant, while a
// JS round-trip through the same pool still looks exact.
const POOL_OPTIONS = '-c timezone=UTC';

const EMBEDDED_USER = 'postgres';
// Signals that end the run without going through vitest's teardown.
const FATAL_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Same server, different database: `uri` keeps its credentials, host and query. */
function databaseUrl(uri, dbName) {
	const url = new URL(uri);
	url.pathname = `/${dbName}`;
	return url.toString();
}

async function withClient(uri, work) {
	const client = new Client({ connectionString: uri, options: POOL_OPTIONS });
	await client.connect();
	try {
		return await work(client);
	} finally {
		await client.end();
	}
}

async function dropDatabase(uri, name) {
	await withClient(uri, (client) =>
		client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`)
	);
}

// Named after the run's pid: two runs against one TEST_DATABASE_URL server must
// not drop each other's template mid-clone.
function templateName() {
	return `sab_template_${process.pid}`;
}

async function buildTemplate(uri, template) {
	await dropDatabase(uri, template);
	await withClient(uri, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(template)}`));
}

/** Clones the run's template (PG_TEST_TEMPLATE). Returns the new database's URL. */
async function createDatabaseFromTemplate(uri, name) {
	await withClient(uri, (client) =>
		client.query(
			`CREATE DATABASE ${client.escapeIdentifier(name)} TEMPLATE ${client.escapeIdentifier(process.env.PG_TEST_TEMPLATE)}`
		)
	);
	return databaseUrl(uri, name);
}

/** Empties every public table (not the migration ledger) and restarts identities. */
async function truncateAll(client) {
	const { rows } = await client.query(
		`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
	);
	if (rows.length === 0) return;
	const tables = rows.map((r) => `public.${client.escapeIdentifier(r.tablename)}`).join(', ');
	await client.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === 'EPERM';
	}
}

function readPostmasterPid(dataDir) {
	try {
		const pid = Number.parseInt(fs.readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8'), 10);
		return Number.isInteger(pid) ? pid : null;
	} catch {
		return null;
	}
}

// A recycled pid must not get a signal meant for a crashed run's postmaster.
function isPostgresProcess(pid) {
	if (process.platform === 'win32') return pidAlive(pid);
	try {
		return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).includes('postgres');
	} catch {
		return false;
	}
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Synchronous so it can run inside signal and 'exit' handlers: asks a still
// running postmaster for a fast shutdown, waits briefly, then removes the dir.
function sweepSync(dataDir) {
	const pid = readPostmasterPid(dataDir);
	if (pid && isPostgresProcess(pid)) {
		try {
			process.kill(pid, 'SIGINT');
		} catch {
			// Already gone.
		}
		for (let i = 0; i < 40 && pidAlive(pid); i++) sleepSync(50);
	}
	try {
		fs.rmSync(dataDir, { recursive: true, force: true });
	} catch {
		// Windows can still hold files of a just-killed server (EBUSY); the next
		// run's stale sweep retries.
	}
}

// Directories are `sab-pg-<checkout hash>-<label>-<owner pid>`. Each run owns its
// own, so concurrent runs from one checkout never touch each other's server.
const dataDirPrefix = `sab-pg-${crypto
	.createHash('sha1')
	.update(path.resolve(__dirname, '..', '..'))
	.digest('hex')
	.slice(0, 8)}-`;

// A run killed by SIGKILL, an OOM kill or a closed terminal never reaches its
// handlers; the next run removes what such a run left behind.
function sweepStaleDataDirs() {
	for (const entry of fs.readdirSync(os.tmpdir())) {
		if (!entry.startsWith(dataDirPrefix)) continue;
		const owner = Number.parseInt(entry.slice(entry.lastIndexOf('-') + 1), 10);
		if (Number.isInteger(owner) && !pidAlive(owner)) sweepSync(path.join(os.tmpdir(), entry));
	}
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function launch(EmbeddedPostgres, dataDir) {
	// Loopback only, but a fixed password would still let any local process in.
	const password = crypto.randomBytes(16).toString('hex');
	const port = await freePort();
	const server = new EmbeddedPostgres({
		databaseDir: dataDir,
		port,
		user: EMBEDDED_USER,
		password,
		persistent: false,
		initdbFlags: INITDB_FLAGS,
		postgresFlags: SERVER_FLAGS,
		onLog: () => {},
		onError: (message) => console.error('[embedded-postgres]', message),
	});
	await server.initialise();
	await server.start();
	const uri = `postgresql://${EMBEDDED_USER}:${password}@127.0.0.1:${port}/postgres`;
	return { server, uri };
}

/**
 * Starts the server and builds the template. Resolves to { uri, template, stop }.
 * `uri` is a superuser URL on the maintenance database. `label` separates
 * independent servers started by the same process.
 */
async function startEmbeddedPostgres({ label = 'run' } = {}) {
	sweepStaleDataDirs();
	const dataDir = path.join(os.tmpdir(), `${dataDirPrefix}${label}-${process.pid}`);
	fs.rmSync(dataDir, { recursive: true, force: true });

	const onSignal = (signal) => {
		sweepSync(dataDir);
		// Hand the signal back to the default action when nothing else (vitest)
		// is listening, so the process still dies from it. Under vitest the server
		// is gone before vitest finishes draining, so in-flight tests fail loudly.
		if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
	};
	const onExit = () => sweepSync(dataDir);
	for (const signal of FATAL_SIGNALS) process.once(signal, onSignal);
	process.once('exit', onExit);
	const detach = () => {
		for (const signal of FATAL_SIGNALS) process.removeListener(signal, onSignal);
		process.removeListener('exit', onExit);
	};

	try {
		const { default: EmbeddedPostgres } = await import('embedded-postgres');
		let started;
		try {
			started = await launch(EmbeddedPostgres, dataDir);
		} catch (err) {
			// The probed port can be taken by another run before postgres binds it.
			console.error('[embedded-postgres] start failed, retrying once:', err.message);
			sweepSync(dataDir);
			started = await launch(EmbeddedPostgres, dataDir);
		}
		const { server, uri } = started;
		const pid = readPostmasterPid(dataDir);
		// stop() and the signal handlers find the server through this pid.
		if (!pid) throw new Error(`embedded postgres started without a postmaster.pid in ${dataDir}`);
		const template = templateName();
		await buildTemplate(uri, template);

		return {
			uri,
			template,
			dataDir,
			pid,
			async stop() {
				detach();
				// A signal handler may already have shut the server down.
				if (pidAlive(pid)) await server.stop();
				fs.rmSync(dataDir, { recursive: true, force: true });
				if (pidAlive(pid)) {
					throw new Error(`embedded postgres (pid ${pid}) is still running after stop`);
				}
			},
		};
	} catch (err) {
		detach();
		sweepSync(dataDir);
		throw err;
	}
}

/** Entry for globalSetup: embedded server, or the TEST_DATABASE_URL server. Resolves to { uri, template, stop }. */
async function startTestPostgres() {
	const external = process.env.TEST_DATABASE_URL;
	if (!external) return startEmbeddedPostgres();
	const template = templateName();
	await buildTemplate(external, template);
	return {
		uri: external,
		template,
		stop: () => dropDatabase(external, template),
	};
}

module.exports = {
	POOL_OPTIONS,
	databaseUrl,
	withClient,
	dropDatabase,
	createDatabaseFromTemplate,
	truncateAll,
	pidAlive,
	sweepSync,
	startEmbeddedPostgres,
	startTestPostgres,
};
