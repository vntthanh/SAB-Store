/**
 * The PostgreSQL test harness itself: isolation, real locks, a pinned session
 * zone, clean teardown and the collation production will run with.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Client, Pool } = require('pg');
const postgres = require('../helpers/postgres');

const baseUri = process.env.PG_TEST_URI;
const ownName = `test_${process.pid}`;
const cleanup = [];

async function connect(url, config = {}) {
	const client = new Client({ connectionString: url, ...config });
	await client.connect();
	cleanup.push(() => client.end());
	return client;
}

afterEach(async () => {
	while (cleanup.length) await cleanup.pop()();
});

describe('database per file', () => {
	it('runs this file in its own database cloned from the template', async () => {
		const client = await connect(process.env.DATABASE_URL);
		const { rows } = await client.query('SELECT current_database() AS db');
		expect(rows[0].db).toBe(ownName);
	});

	it('keeps two workers apart', async () => {
		const otherName = `${ownName}_other`;
		const otherUrl = await postgres.createDatabaseFromTemplate(baseUri, otherName);
		cleanup.push(() => postgres.dropDatabase(baseUri, otherName));

		const mine = await connect(process.env.DATABASE_URL);
		const theirs = await connect(otherUrl);
		await mine.query('CREATE TABLE isolation_probe (id int)');
		await mine.query('INSERT INTO isolation_probe VALUES (1)');

		const { rows } = await theirs.query(`SELECT to_regclass('public.isolation_probe') AS t`);
		expect(rows[0].t).toBeNull();
		await mine.query('DROP TABLE isolation_probe');
	});

	it('truncates every table, restarts identities and keeps the migration ledger', async () => {
		const client = await connect(process.env.DATABASE_URL);
		await client.query('CREATE TABLE truncate_probe (id serial PRIMARY KEY, name text)');
		await client.query('CREATE TABLE truncate_child (id serial PRIMARY KEY, parent int REFERENCES truncate_probe(id))');
		const ledgerBefore = (await client.query('SELECT count(*)::int AS n FROM _prisma_migrations')).rows[0].n;
		expect(ledgerBefore).toBeGreaterThan(0);
		await client.query(`INSERT INTO truncate_probe (name) VALUES ('a'), ('b')`);
		await client.query('INSERT INTO truncate_child (parent) VALUES (2)');

		await postgres.truncateAll(client);

		expect((await client.query('SELECT count(*)::int AS n FROM truncate_probe')).rows[0].n).toBe(0);
		expect((await client.query('SELECT count(*)::int AS n FROM truncate_child')).rows[0].n).toBe(0);
		expect((await client.query('SELECT count(*)::int AS n FROM _prisma_migrations')).rows[0].n).toBe(ledgerBefore);
		const inserted = await client.query(`INSERT INTO truncate_probe (name) VALUES ('c') RETURNING id`);
		expect(inserted.rows[0].id).toBe(1);

		await client.query('DROP TABLE truncate_child, truncate_probe');
	});
});

describe('row locks', () => {
	it('makes SELECT ... FOR UPDATE in B wait until A commits', async () => {
		const a = await connect(process.env.DATABASE_URL);
		const b = await connect(process.env.DATABASE_URL);
		await a.query('CREATE TABLE lock_probe (id int PRIMARY KEY, n int)');
		await a.query('INSERT INTO lock_probe VALUES (1, 0)');

		await a.query('BEGIN');
		await a.query('SELECT * FROM lock_probe WHERE id = 1 FOR UPDATE');

		let bSeen = false;
		await b.query('BEGIN');
		const blocked = b.query('SELECT * FROM lock_probe WHERE id = 1 FOR UPDATE').then((res) => {
			bSeen = true;
			return res;
		});
		// If an assertion below fails, cleanup ends B with this query pending.
		blocked.catch(() => {});

		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(bSeen).toBe(false);

		await a.query('UPDATE lock_probe SET n = 7 WHERE id = 1');
		await a.query('COMMIT');
		const res = await blocked;
		expect(bSeen).toBe(true);
		// READ COMMITTED re-reads the locked row after A's commit.
		expect(res.rows[0].n).toBe(7);
		await b.query('COMMIT');
		await a.query('DROP TABLE lock_probe');
	});
});

describe('session time zone', () => {
	const instant = new Date('2026-10-11T00:30:15.123Z');
	const asUtc = `to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
	// The shape that goes wrong: a timestamp string with no offset, which the
	// server reads in the session zone.
	const offsetless = instant.toISOString().replace('Z', '');
	let plusSevenUrl;

	beforeAll(async () => {
		const name = `${ownName}_tz`;
		plusSevenUrl = await postgres.createDatabaseFromTemplate(baseUri, name);
		await postgres.withClient(baseUri, (client) =>
			client.query(`ALTER DATABASE ${client.escapeIdentifier(name)} SET timezone = '+07'`)
		);
		return () => postgres.dropDatabase(baseUri, name);
	});

	async function writeAndReadBack(pool, value) {
		await pool.query('CREATE TABLE IF NOT EXISTS tz_probe (id serial, ts timestamptz)');
		await pool.query('TRUNCATE tz_probe');
		await pool.query('INSERT INTO tz_probe (ts) VALUES ($1)', [value]);
		const { rows } = await pool.query(`SELECT ${asUtc} AS utc FROM tz_probe`);
		return rows[0].utc;
	}

	it('stores the written instant through the configured pool on a +07 database', async () => {
		const pool = new Pool({ connectionString: plusSevenUrl, max: 1, options: postgres.POOL_OPTIONS });
		cleanup.push(() => pool.end());
		expect((await pool.query('SELECT extract(timezone FROM now())::int AS off')).rows[0].off).toBe(0);

		expect(await writeAndReadBack(pool, instant)).toBe('2026-10-11T00:30:15.123Z');
		expect(await writeAndReadBack(pool, offsetless)).toBe('2026-10-11T00:30:15.123Z');
	});

	it('documents that an unpinned pool on a +07 database stores a different instant', async () => {
		const pool = new Pool({ connectionString: plusSevenUrl, max: 1 });
		cleanup.push(() => pool.end());
		expect((await pool.query('SELECT extract(timezone FROM now())::int AS off')).rows[0].off).toBe(7 * 3600);

		expect(await writeAndReadBack(pool, offsetless)).toBe('2026-10-10T17:30:15.123Z');
	});
});

describe('teardown', () => {
	it('stop() removes the data dir and the server process', async () => {
		const server = await postgres.startEmbeddedPostgres({ label: 'stop' });
		cleanup.push(async () => postgres.sweepSync(server.dataDir));
		expect(fs.existsSync(server.dataDir)).toBe(true);
		expect(postgres.pidAlive(server.pid)).toBe(true);

		await server.stop();

		expect(fs.existsSync(server.dataDir)).toBe(false);
		expect(postgres.pidAlive(server.pid)).toBe(false);
	});

	// The whole suite's exit status rides on this: vitest reports failed tests by
	// setting the exit code and letting the main process drain. The process must
	// also end without the package's 'exit' handler crashing.
	it.each([
		// The package's own behaviour, pinned. If this case fails, the package no
		// longer exits 0 and importEmbeddedPostgres' workaround can be deleted.
		['the plain package', 0, `import('embedded-postgres')`],
		['the helper', 1, `require(HELPER).importEmbeddedPostgres()`]
	])('a process that set exit code 1 after importing %s exits with %s', (_label, expected, load) => {
		const helperPath = path.join(__dirname, '..', 'helpers', 'postgres.js');
		// Exit 7 on a failed import, so "could not load" never passes for either case.
		const script = `const HELPER = ${JSON.stringify(helperPath)}; ${load}.then(() => { process.exitCode = 1; }, (err) => { console.error(err); process.exit(7); });`;
		const run = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..', '..'), stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 15000 });
		expect(run.status, run.stderr).toBe(expected);
		expect(run.stderr).not.toMatch(/done is not a function/);
	});

	// Windows has no SIGINT delivery to a child process: kill() terminates it outright.
	it.skipIf(process.platform === 'win32')('SIGINT leaves no data dir and no server process', async () => {
		const helperPath = path.join(__dirname, '..', 'helpers', 'postgres.js');
		const script = `
			require(${JSON.stringify(helperPath)})
				.startEmbeddedPostgres({ label: 'sigint' })
				.then((s) => {
					console.log(JSON.stringify({ dir: s.dataDir, pid: s.pid }));
					setInterval(() => {}, 1000);
				});
		`;
		const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
		let started = null;
		// SIGKILL skips the child's own cleanup, so a failed assertion must not
		// leave its server behind.
		cleanup.push(async () => {
			child.kill('SIGKILL');
			if (started) postgres.sweepSync(started.dir);
		});

		started = await new Promise((resolve, reject) => {
			let out = '';
			child.once('error', reject);
			child.once('exit', (code) => reject(new Error(`child exited early (${code})`)));
			child.stdout.on('data', (chunk) => {
				out += chunk;
				if (out.includes('\n')) resolve(JSON.parse(out));
			});
		});
		expect(fs.existsSync(started.dir)).toBe(true);
		expect(postgres.pidAlive(started.pid)).toBe(true);

		child.removeAllListeners('exit');
		const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal || code)));
		child.kill('SIGINT');
		// Either the default action (signal) or embedded-postgres' own handler,
		// which exits with 130 = 128 + SIGINT; what matters is what is left below.
		expect([130, 'SIGINT']).toContain(await exited);

		expect(fs.existsSync(started.dir)).toBe(false);
		expect(postgres.pidAlive(started.pid)).toBe(false);
	}, 60000);
});

describe('collation', () => {
	it('matches what the production image answers', async () => {
		const client = await connect(process.env.DATABASE_URL);

		const provider = await client.query(
			`SELECT datlocprovider FROM pg_database WHERE datname = current_database()`
		);
		expect(provider.rows[0].datlocprovider).toBe('b');

		const sorted = await client.query(
			`SELECT v FROM unnest($1::text[]) AS t(v) ORDER BY v`,
			[['Đa', 'Da', 'Dz', 'đa', 'Áb', 'Ab', 'Zb', 'ab']]
		);
		expect(sorted.rows.map((r) => r.v)).toEqual(['Ab', 'Da', 'Dz', 'Zb', 'ab', 'Áb', 'Đa', 'đa']);

		const { rows } = await client.query(`
			SELECT 'Đ' ILIKE 'đ' AS ilike_d,
				lower('ÁĂÊĐ') AS lowered,
				upper('áăêđ') AS uppered,
				'Áb' ILIKE 'a%' AS accent_matches_a
		`);
		expect(rows[0]).toEqual({
			ilike_d: true,
			lowered: 'áăêđ',
			uppered: 'ÁĂÊĐ',
			accent_matches_a: false,
		});
	});
});
