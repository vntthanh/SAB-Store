# Environment Configuration Guide

## Which file to copy

- **Docker Compose (dev or prod)** reads the **root** `.env` — `cp .env.example .env`. This is
  what `compose.yml`/`prod.compose.yml` inject into every container.
- **Running the backend directly** (`cd backend && pnpm dev`, no Docker) reads
  `backend/.env` — `cp backend/.env.example backend/.env`. This file is loaded by plain
  `dotenv`, which does **not** expand `${VAR}` references, so `PUBLIC_URL`/`BASE_URL`/
  `CORS_ORIGIN` are written out as three literal values there instead of one interpolated
  source (see the comment at the top of `backend/.env.example`).
- The frontend needs no `.env` file. It is a static Vite/React bundle that calls the API via
  the relative path `/api` — no build-time or runtime URL variable exists (`VITE_API_URL` was
  deleted, not renamed; see AD-3 in the hardening plan).

Both `.env.example` files are commented in place with what each variable does and why — that
comment is the source of truth for the current variable list, not this document. Read it
before copying.

## Why `PUBLIC_URL` (AD-2)

`CORS_ORIGIN` and `BASE_URL` used to be set independently and had drifted to hold copies of
the same domain. `prod.compose.yml`/`compose.yml` now derive both from one `PUBLIC_URL`
(`CORS_ORIGIN: ${PUBLIC_URL}`, `BASE_URL: ${PUBLIC_URL}`) — one place to change the domain,
and `${PUBLIC_URL:?PUBLIC_URL is required}` makes a missing value fail the container at boot
instead of silently falling back to `localhost`.

## What was deliberately NOT merged

`MONGO_INITDB_ROOT_PASSWORD` (the Mongo root account) currently doubles as the application's
own credential (the password inside `MONGODB_URI`). They read as duplicates but are not the
same thing — a root credential should not also be the app's day-to-day credential. The root
`.env.example` carries a `TODO` at the relevant lines: split it into a scoped user
(`db.createUser()` with `readWrite` on the app database) rather than merging further. Not
done yet — the user still needs to be created deliberately by an operator with server access.

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

## `INIT_EMPTY_DATABASE`

In production the backend refuses to initialise a database that has no users, and never
seeds sample products or placeholder bank accounts. The refusal protects against a
`MONGODB_URI` that points at a wrong or empty database. For the first production deploy on
a genuinely empty database, set `INIT_EMPTY_DATABASE` to that database's name (e.g.
`INIT_EMPTY_DATABASE=sabstore`), then remove it. The value must match the database the
backend connects to, so a leftover flag never unlocks a different, mistyped one; the backend
logs a warning while the flag is set on a database that already has users.

Bank account, bank and payment prefix are not environment variables: the admin sets them in
**Settings**. Until then production accepts orders without a payment QR code, so configure
Settings before opening the store.

## Before deploying

1. Every secret is `${VAR:?message}` in `prod.compose.yml` — a missing one refuses to boot the
   container. See `docs/deployment.md` for the full pre-deploy checklist and the correct order
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
