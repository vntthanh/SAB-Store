# Environment Configuration Guide

## Which file to copy

- **Docker Compose (dev or prod)** reads the **root** `.env` — `cp .env.example .env`.
  `compose.yml`/`prod.compose.yml` use it for `${VAR}` interpolation; each service receives
  only the variables its `environment:` lists.
- **Running the backend directly** (`cd backend && pnpm dev`, no Docker) reads
  `backend/.env` — `cp backend/.env.example backend/.env`. This file is loaded by plain
  `dotenv`, which does **not** expand `${VAR}` references, so `PUBLIC_URL`/`BASE_URL`/
  `CORS_ORIGIN` are written out as three literal values there instead of one interpolated
  source (see the comment at the top of `backend/.env.example`).
- The frontend needs no `.env` file. It is a static Vite/React bundle that calls the API via
  the relative path `/api` — no build-time or runtime URL variable exists (`VITE_API_URL` was
  deleted, not renamed; the SPA calls the API on its own origin).

Both `.env.example` files are commented in place with what each variable does and why — that
comment is the source of truth for the current variable list, not this document. Read it
before copying.

## Why `PUBLIC_URL`

`CORS_ORIGIN` and `BASE_URL` used to be set independently and had drifted to hold copies of
the same domain. `prod.compose.yml`/`compose.yml` now derive both from one `PUBLIC_URL`
(`CORS_ORIGIN: ${PUBLIC_URL}`, `BASE_URL: ${PUBLIC_URL}`) — one place to change the domain,
and `${PUBLIC_URL:?PUBLIC_URL is required}` makes a missing value fail the container at boot
instead of silently falling back to `localhost`.

## PostgreSQL and credential scoping

PostgreSQL is the backend's default store (`DATA_BACKEND` unset or `postgres`, connection in
`DATABASE_URL`). The dev stack (`compose.yml`) and production (`coolify.compose.yml`) run on it.
`prod.compose.yml`, the fallback for a host without Coolify, runs the postgres service and the
release job but still pins the backend to MongoDB (`DATA_BACKEND: mongo`); using it needs the
same data migration first.

- `SAB_PG_USER`, `SAB_PG_PASSWORD`, `SAB_PG_DB` are new credentials, never a reused Mongo
  value. The user and database names use only `a-z 0-9 _`; the password is lowercase hex of at
  least 32 characters (`openssl rand -hex 24`) because it is embedded unescaped in
  `DATABASE_URL`. Otherwise the postgres container exits at start-up with the reason in its log.
- The services that connect list them explicitly in their `environment:`: the postgres
  service (`POSTGRES_*`), the release job (`DATABASE_URL`) and, when it runs on PostgreSQL, the
  backend (`DATABASE_URL`). That scoping holds for `compose.yml` and `prod.compose.yml`.
  **Coolify does not scope**: it passes every variable of the app to every service, so
  `SAB_PG_*`, `JWT_SECRET`, the Mongo root password and the rest are readable inside every
  container of the app, frontend, redis and seaweedfs included (measured on production
  2026-10-13). Treat shell access to any of them as access to all its secrets, including the
  session signing key. In Coolify, create
  them with "Available during build" off, or every build stage receives them as `ARG`.
- `POSTGRES_INITDB_ARGS` (builtin `C.UTF-8` locale, the same as the test databases) only takes
  effect when the data directory is initialised; changing it later does nothing.
- The release job (`backend/scripts/release.sh`) runs before the backend: it writes a
  `pg_dump` to the backups volume and then runs `prisma migrate deploy`. A failed or empty dump
  stops it before any migration. The backend refuses to boot while migrations are pending.

The Mongo variables (`MONGO_INITDB_*`, `MONGO_REPLICA_KEY`, `MONGODB_URI`) stay until MongoDB is
removed, for the rollback path and `prod.compose.yml` only. In Coolify the backend runs with
`DATA_BACKEND=postgres` and does not use `MONGODB_URI`, though Coolify still passes it in. In
`prod.compose.yml` the Mongo root account still doubles as the app's credential; it retires
with MongoDB instead of being split.

## Object storage (SeaweedFS)

The storage service is SeaweedFS (S3 API). The backend talks to it with the `minio` SDK, so
the variables keep the `MINIO_*` names — the names describe the client, not the server.

- `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` become the one S3 identity, which has rights on
  the `MINIO_BUCKET_NAME` bucket only. The backend uses the same pair as
  `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`.
- Both must be at least 16 characters, must not be `minioadmin`, and must not contain `"` or
  `\`. Otherwise the storage container exits at start-up with the reason in its log (values
  are never printed). This is deliberate: the platform turns an unset variable into an empty
  string, and a storage service started without an identity would accept anonymous writes.
- `MINIO_ENDPOINT` is fixed to the storage service name in the compose files; a stale value
  left in the platform's environment is ignored.

## Order mail (SMTP)

There are no SMTP environment variables. An admin configures the server, sender and the two
mails (order confirmation, status change) on the Settings page; it is off until the master
switch is turned on. The password is stored encrypted and is never shown again; leaving it
blank on a later save keeps it. The settings live in their own table, so the admin database
export never contains them.

The order confirmation is rendered from `backend/templates/order-created.html`; the tracking link
in it is `BASE_URL` (derived from `PUBLIC_URL`) plus `/order-tracking?code=<orderCode>`. The two
banner images in that template are Google Drive thumbnails.

## Customer sign-in: email code and Google

Customers sign in with a one-time code mailed to them, or with Google One Tap. See
[`storefronts.md`](storefronts.md) for who can see and order from what.

- **Email code needs SMTP.** The code travels by the mail configured above; with the master
  switch off, sending a code is refused and customers cannot use that method.
- **Google sign-in is an admin setting**, not an environment variable: the "Google Client ID"
  field on the admin Settings page. It takes the Google Cloud OAuth **Web** client id, whose
  authorized JavaScript origin must be `PUBLIC_URL`. No redirect URI is needed: the button runs in
  popup mode and hands the ID token to the page, which posts it to the backend. No client secret
  either. Empty turns Google off: the button is hidden and `/api/auth/one-tap/callback` answers
  503. A saved change applies to the next sign-in without a restart (`backend/lib/auth-guards.js`,
  `oneTapOptions`). An old `GOOGLE_CLIENT_ID` environment variable is ignored and can be deleted.
- `APPSCRIPT_URL` no longer exists; remove it from any environment that still carries it.

## `ADMIN_*` and `INIT_EMPTY_DATABASE`

`ADMIN_EMAIL`, `ADMIN_USERNAME` and `ADMIN_PASSWORD` are read only when the database has no
admin, to create the first one, and then all three are needed together. Once an admin exists
they are ignored and can be removed from the environment. On a database with no users at all
the backend refuses to boot without them; on one that has users but no admin it boots and
logs a warning.

In production the backend refuses to initialise a database that has no users, and never
seeds sample products or placeholder bank accounts. The refusal protects against a
connection string that points at a wrong or empty database. For the first production deploy on
a genuinely empty database, set `INIT_EMPTY_DATABASE` to that database's name (e.g.
`INIT_EMPTY_DATABASE=sabstore`), then remove it. The value must match the database the
backend connects to, so a leftover flag never unlocks a different, mistyped one; the backend
logs a warning while the flag is set on a database that already has users.

Bank account, bank and payment prefix are not environment variables: the admin sets them in
**Settings**. Until then production accepts orders without a payment QR code, so configure
Settings before opening the store.

## Before deploying

1. Every secret in `prod.compose.yml` is `${VAR:?message}` — a missing one refuses to boot
   the container (`ADMIN_*` are not secrets of that kind; see above). See `docs/deployment.md` for the full pre-deploy checklist and the correct order
   to rotate the Mongo password (rotating it in `.env` alone, without first running
   `db.changeUserPassword()` against the live database, is a no-op against an existing data
   volume).
2. Never commit `.env` (only `.env.example`) to version control.
3. Use different secrets for production and development.

## Docker Compose usage

```bash
docker compose up -d          # dev stack (compose.yml)
docker compose logs -f
docker compose down
```

Production always uses `-f prod.compose.yml` explicitly — see `docs/deployment.md`.
