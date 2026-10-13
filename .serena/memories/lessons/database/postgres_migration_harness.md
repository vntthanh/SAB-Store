# Postgres/Prisma migration — what was measured (2026-10-11)

## Test harness (backend/tests/helpers/postgres.js)
- Each run starts one embedded-postgres 17 server and gives every test file its own database, cloned from the template `sab_template_<pid>` that holds the real migrations. Cost measured on the Mac: the full suite went from 53 s to 66 s with per-file databases, and to ~85 s once the template carried the schema of 20+ tables.
- Data dir is `$TMPDIR/sab-pg-<hash>-<label>-<ownerPid>`. When the owner process is SIGKILLed or OOM-killed, the postmaster survives and keeps the dir. The next start sweeps dirs whose owner is dead, after checking with `ps` that the pid really is a postgres process. Measured: dir and postmaster were still there after `kill -9`, both gone after the next start.
- Every pg session must pin `-c timezone=UTC`. adapter-pg sends timestamps without an offset, so a session in another zone stores the wrong instant while a JS round-trip through the same pool still looks right.
- **embedded-postgres turned every failing run into exit 0 (measured 2026-10-12).** Importing it registers `async-exit-hook`, whose `beforeExit` handler calls `process.exit(0)`. In vitest's main process (globalSetup) that overrode vitest's exit code 1, so the git hooks passed failing suites from the harness's first day until this was found. Bisect: bare vitest config exits 1, adding the globalSetup exits 0. `importEmbeddedPostgres()` removes that one listener; a harness test pins both the package behaviour and the fix. Always read the `Tests … failed` line, not only the exit code, when a gate looks too green.
- `TEST_DATABASE_URL` points tests at an external server. That server must be throwaway: the run creates and drops `sab_template_<pid>` and `test_<pid>` there.

## Commits and knip
- A commit that only adds dependencies (pg, embedded-postgres, prisma) **fails knip** in pre-commit (unused dependencies). Put the deps in the same commit as the code that uses them.

## Testing the NoSQL guard
- `app.set('query parser', 'simple')` blocks `?x[$ne]=` objects before `utils/query-guard.js` sees them. Route-level injection tests therefore stay green even with `asString` disabled. They only go red when the parser and the guard are both disabled (mutation-tested). The guard's own layer is covered by `tests/smoke/query-guard.test.js`.

## Prisma in the image (backend/Dockerfile)
- The `gen` stage generates the client into `backend/generated` (outside node_modules), and the runner COPYs it in. The runner has no Prisma CLI or engines and grew +3.1 MB. The `release` target sits before `runner`, so a build without `--target` (Coolify) still produces the runtime image.
- `prisma.config.cjs` falls back to `postgresql://…@invalid.invalid/…`. `generate` needs no DB, and `migrate` without a URL can never hit a local trust-auth Postgres.
- `migrate diff` rewrites a `dbgenerated` default unless it is written exactly as Postgres prints it back, for example `substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 24)`.
- A hand-added `ALTER COLUMN tags SET NOT NULL` at the end of the migration does not register as drift.

## Repository refactor (phase 03, measured 2026-10-12)
- **Legacy order JSON differs between hydrated and lean reads.** A hydrated read fills missing schema defaults and changes key order. A lean read returns only the stored keys. When moving a read into a repo, keep the old mode (the `complete` option in `data/mongo/orders.js`) or the API JSON changes. Parity was checked by calling 32 routes before and after, with ids, dates and codes masked.
- **Zod 4: an object key with a bare `z.unknown()` is REQUIRED.** Use `z.unknown().optional()` when the key may be absent.
- **Mutation-test every tie-break test.** Remove `_id` from the sort and the test must fail. Without that, ties fall back to insertion order and the test passes anyway.
- **Signed commits and long hooks.** Commits are signed through the 1Password SSH agent. If the hook runs long (about 2 min for the full suite), 1Password fails with "failed to fill whole buffer" when it is locked or the prompt times out. The staged state survives: unlock 1Password and commit again. Do not disable signing.
- **Scratchpad.** A reboot wipes the session scratchpad, including helper scripts and parked patches. Keep anything you need across a pause in the plan files, not only in the scratchpad.

## Prisma transactions on Postgres (measured 2026-10-12, Prisma 7.10 + adapter-pg)
- **A deadlock inside `$queryRaw`/`$executeRaw` (e.g. `SELECT … FOR UPDATE`) is NOT reported as `P2034`.** It arrives as `P2010` carrying SQLSTATE `40P01`, and a serialization failure carries `40001`. Retrying only on `P2034` would skip exactly those deadlocks. `data/postgres/tx.js` retries on P2034 or 40P01/40001. This was proven with a real two-transaction deadlock test, where a barrier makes each side hold its first lock before asking for the second (it takes about 1 s because of the server's deadlock_timeout).
- **Lock product rows `FOR NO KEY UPDATE` when only a non-key column changes.** `FOR UPDATE` conflicts with the `KEY SHARE` that FK inserts (movements, order items) take on the parent row, so order transactions would wait on the stock applier.
- **Assert lock waits through `pg_stat_activity`, not a sleep race:** poll until a session is waiting on a lock, then assert the operation is still pending.
- **Read Committed reads are not a snapshot across statements.** Two reads that must agree (stock and applied sum) need a row lock first, or a single SQL statement.

## better-auth on Prisma and Postgres scripts (measured 2026-10-12)
- **The Prisma pool keeps a script alive for about 30 s.** On Postgres, an operational script exited about 30 s after its work, until `closeDB` also called `$disconnect`. `closeDB` only disconnects when `lib/prisma.js` is already in `require.cache`, so closing never creates a pool.
- **Mongoose's `lowercase` setter also applies to query filters; Prisma compares raw.** `User.exists({ email })` folded a mixed-case `ADMIN_EMAIL`. The Prisma version missed the lowercase-stored admin, so the second boot's `createUser` threw `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`. Fold email and username yourself. better-auth stores both lowercased. (function removed; the seed now keys on whether an admin exists)
- **A non-uuid id on a native uuid column is an empty 500.** better-auth admin routes (`set-user-password`, `ban-user`, `get-user?id=`, `list-user-sessions`, and others) answered 500 on Postgres where Mongo answered 404. A `hooks.before` check with `isUuid` turns it into a 400. A Mongo repo's `InvalidIdError` (CastError) is likewise a 500 in any route catch that does not handle it.
- **jwks is minted by the first authenticated request.** Mongo keeps `jwks` between tests (no model, so cleanup skips it). Postgres `truncateAll` empties it. A test that counts login rows before and after an operation needs a warm-up request.
- **`uuid` 14 is ESM-only, but `require()` works on Node 24.** It is used lazily in the Postgres branch of `lib/auth.js` for `generateId`, since better-auth's built-in `"uuid"` is v4.

## Default-store flip (measured 2026-10-12)
- **Vitest `test.env` reaches the workers, not `globalSetup`.** globalSetup runs in the main process and receives the project as its argument: read `project.config.env.DATA_BACKEND` there (shell variable as fallback), or the Mongo replica set starts on the wrong runs.
- **With Mongo not connected in a Postgres run, only four test files broke**: two `Model.init()` in `beforeAll` (they buffer 30 s, then time out), one `Model.create` in an integer-price test, and the case of `require-replica-set.test.js` that asks the live harness replica set (now `skipIf(POSTGRES)`). `new Model(x).validate()` runs the schema validators without a connection.
- **Boot check for migrations.** `lib/require-migrations.js` compares the `prisma/migrations` directories shipped in the runner image (`COPY backend ./` keeps them; only `tests` is ignored) with `_prisma_migrations`. Measured on a scratch postgres:17: backend before the release step exits 1 after about 4 s with "no _prisma_migrations table"; after the release step `/health` is 200, the admin is created, and a second boot is idempotent (one user row).
- **macOS has no `timeout` command.** A smoke script that wrapped `docker run` in it exited 127 at once. Start the container detached and poll `docker inspect -f '{{.State.Running}}'`.
- **A connection string can be quoted by driver errors.** `ErrorLogger.log` and `logCritical` now remove the `scheme://user:password@` part (greedy to the last `@` of the token) and keep the host.

## Migration rehearsal (measured 2026-10-12, prod dump of 20:51)
- **Dump:** `mongodump --oplog --archive --gzip` inside the prod mongo container, the password in a 0600 `--config` file inside the container (removed after), so nothing secret is on argv. A script piped through `ssh host 'bash -s' < file` loses the rest of itself to the first `docker exec -i` (it reads stdin): use no `-i`, or `< /dev/null`. `mongorestore --oplogReplay` refuses `--nsExclude`; restore everything into the scratch mongod.
- **Loader on real data:** dry run and `--apply` passed first time, about 1 s each; no legacy repair was needed; 63 of 69 sessions were expired and dropped.
- **JWKS is bound to `JWT_SECRET`:** under another secret the migrated key does not decrypt and `get-session` itself returns 500. A local rehearsal deletes the scratch `jwks` row; production must keep the same secret.
- **macOS AirPlay Receiver holds :5000**, the port the Vite proxy expects; a local app run used backend :5051 and a throwaway Vite config overriding only the proxy target.

## Compose postgres + release job (measured 2026-10-12, dev compose on the Mac)
- From `up` to the release job exiting 0 on an empty database took 4 s (postgres healthy, dump, `migrate deploy`). A second run prints "No pending migrations". With a wrong password, pg_dump fails and the job exits 1 before migrating. The whole dev backend was healthy on postgres 13 s after `up`, and the first admin was seeded.
- The postgres guard in `command:` rejects a short or non-hex password and a bad user name with exit 1. `pg_isready -h 127.0.0.1` inside a YAML double-quoted string needs `\"$${VAR}\"`.
- **`log_min_duration_statement` logs bind values in full by default.** That means customer data and session tokens end up in Loki, so the compose files set `log_parameter_max_length=0`.
- **Deploy A cannot be a cherry-pick of the compose commit onto `main`.** `main`'s Dockerfile has no `release` target, so the build of the release job would fail. The first postgres deploy has to carry the dev backend code, pinned to `DATA_BACKEND: mongo`.
- Missing `SAB_PG_*` in Coolify makes postgres exit, release then fails on `service_healthy`, and `compose up` exits non-zero after Coolify has already removed the old containers. Create them, with build-time off, before that merge.

## Production cutover (measured 2026-10-13, 02:06–02:20 Asia/Saigon)
- Deploy A (dev code, backend pinned to mongo, empty postgres + release job): push with hooks 230 s, Coolify then replaced every container; release exited 0 with one migration, backend healthy on mongo. Coolify starts postgres, waits for the release job, then the backend (`service_completed_successfully` works there).
- Data path (freeze → mongodump → scratch mongo/PG on the Mac → loader → pg_dump → pg_restore on prod): 44 s end to end. 80 orders, 63 of 70 sessions expired and dropped; ledger checksum equal to the migration file.
- Deploy B (backend on postgres): push 216 s, release took a pre-migrate dump of the loaded data and found "No pending migrations"; backend healthy on postgres with the same JWT_SECRET; RSS 146 MiB of 256. Backend down about 5.5 min (freeze 02:13:30 to Deploy B healthy 02:19), most of it Deploy B's pre-push suite; plus about 1 min during Deploy A. Pushing Deploy B's merge before the freeze would not help: Coolify deploys on push.
- **Coolify injects every app variable into every service**, whatever `environment:` lists: `SAB_PG_PASSWORD` and the Mongo root password are visible in the frontend and redis containers too. The per-service scoping in the compose files only controls what the app reads, not what the container receives.
- The `[Storage] ECONNREFUSED` lines at boot are seaweedfs still starting; the retry loop reaches "Object storage is ready" a few seconds later.

## Production data (copy taken 2026-10-10)
- No order has the legacy `pending` status. No product or combo lacks a publicCode. No phone fails `^0[0-9]{9}$`. No price or total is negative or fractional. So the CHECKs are safe.
