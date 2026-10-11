# Postgres/Prisma migration — what was measured (2026-10-11)

## Test harness (backend/tests/helpers/postgres.js)
- Each run starts one embedded-postgres 17 server and gives every test file its own database, cloned from the template `sab_template_<pid>` that holds the real migrations. Cost measured on the Mac: the full suite went from 53 s to 66 s with per-file databases, and to ~85 s once the template carried the schema of 20+ tables.
- Data dir is `$TMPDIR/sab-pg-<hash>-<label>-<ownerPid>`. When the owner process is SIGKILLed or OOM-killed, the postmaster survives and keeps the dir. The next start sweeps dirs whose owner is dead, after checking with `ps` that the pid really is a postgres process. Measured: dir and postmaster were still there after `kill -9`, both gone after the next start.
- Every pg session must pin `-c timezone=UTC`. adapter-pg sends timestamps without an offset, so a session in another zone stores the wrong instant while a JS round-trip through the same pool still looks right.
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

## Production data (copy taken 2026-10-10)
- No order has the legacy `pending` status. No product or combo lacks a publicCode. No phone fails `^0[0-9]{9}$`. No price or total is negative or fractional. So the CHECKs are safe.
