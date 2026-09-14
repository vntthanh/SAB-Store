# Environment Configuration Guide

## Which file to copy

- **Docker Compose (dev or prod)** reads the **root** `.env` — `cp .env.example .env`. This is
  what `compose.yml`/`prod.compose.yml` inject into every container.
- **Running the backend directly** (`cd backend && yarn dev`, no Docker) reads
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

`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` (the object-storage root account) and
`MONGO_INITDB_ROOT_PASSWORD` (the Mongo root account) currently double as the application's
own credentials (`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`, the password inside `MONGODB_URI`).
They read as duplicates but are not the same thing — a root credential should not also be the
app's day-to-day credential. Both `.env.example` files carry a `TODO` at the relevant lines:
split each into a scoped service account (`mc admin user add` + a bucket-only policy for
MinIO; `db.createUser()` with `readWrite` on the app database for Mongo) rather than merging
them further. Not done yet — the account/policy still needs to be created deliberately by an
operator with server access.

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
