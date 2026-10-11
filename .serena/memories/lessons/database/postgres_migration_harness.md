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

## Repository refactor (phase 03, measured 2026-10-12)
- **Legacy order JSON differs between hydrated and lean reads.** A hydrated read fills missing schema defaults and changes key order. A lean read returns only the stored keys. When moving a read into a repo, keep the old mode (the `complete` option in `data/mongo/orders.js`) or the API JSON changes. Parity was checked by calling 32 routes before and after, with ids, dates and codes masked.
- **Zod 4: an object key with a bare `z.unknown()` is REQUIRED.** Use `z.unknown().optional()` when the key may be absent.
- **Mutation-test every tie-break test.** Remove `_id` from the sort and the test must fail. Without that, ties fall back to insertion order and the test passes anyway.
- **Signed commits and long hooks.** Commits are signed through the 1Password SSH agent. If the hook runs long (about 2 min for the full suite), 1Password fails with "failed to fill whole buffer" when it is locked or the prompt times out. The staged state survives: unlock 1Password and commit again. Do not disable signing.
- **Scratchpad.** A reboot wipes the session scratchpad, including helper scripts and parked patches. Keep anything you need across a pause in the plan files, not only in the scratchpad.

## Production data (copy taken 2026-10-10)
- No order has the legacy `pending` status. No product or combo lacks a publicCode. No phone fails `^0[0-9]{9}$`. No price or total is negative or fractional. So the CHECKs are safe.
