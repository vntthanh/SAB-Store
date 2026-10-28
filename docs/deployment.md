# Deploy runbook

Authoritative deploy procedure for SAB-Store production (`store.sabies.vn`). Supersedes the
step lists in `DEPLOYMENT_UPDATE.md` (that file is a historical record of one earlier
migration, kept for context, not a deploy guide).

A human runs every step below. Nothing here is automated.

## Current production: Coolify (read this first)

Since 2026-09-21 production runs on Coolify from `coolify.compose.yml`; the rest of this runbook
covers `prod.compose.yml` on a host without Coolify and is kept as the fallback path.

- **Deploy** = merge `dev` into `main` with a merge commit (keep `dev`). A GitHub webhook makes
  Coolify build both images from source and replace the containers. A failed build leaves the
  running containers untouched.
- **Downtime per deploy**: Coolify removes every container of the project before `compose up`, so
  the site is down from the first stop until the new frontend is healthy (measured ~100 s before
  the tuning in `coolify.compose.yml`: slow nginx stops, a second image build at `up`,
  serial health waits). Re-measure with a 1 req/s probe after changing anything that affects
  stop, start or healthcheck timing; getting close to zero needs Coolify to keep the old
  containers running until the new ones are healthy, which the compose build pack does not do.
- **No deployment appeared after a push**: the webhook was not delivered (it happened on
  2026-09-29). Check the repo's Settings → Webhooks → Recent Deliveries and redeliver, or press
  Deploy in the Coolify UI.
- **Build-time variables**: Coolify injects every variable marked "Available during build" as an
  `ARG` into every Dockerfile stage. Keep secrets NOT available during build; the Dockerfiles
  pass `--prod` / `--prod=false` explicitly so an injected `NODE_ENV` cannot change what gets installed.
- **Build context = repository root.** The repo is a pnpm workspace (`pnpm-workspace.yaml`:
  `backend`, `frontend`, `packages/*`) with one `pnpm-lock.yaml` at the root, so both images
  build with `context: .` and `dockerfile: backend/Dockerfile` / `frontend/Dockerfile`. Coolify
  needs no setting change (Base Directory `/`, Compose Location `/coolify.compose.yml`). What
  enters a build is decided by the root `.dockerignore` and, per image, by
  `backend/Dockerfile.dockerignore` / `frontend/Dockerfile.dockerignore` (BuildKit prefers the
  per-Dockerfile file). Rules there use `**/`: a bare name such as `uploads` only matches at the
  context root. The backend image is made with `pnpm deploy --prod` (with `inject-workspace-packages`
  set for that one command), not `pnpm prune`. Do not add `--legacy`: it re-resolves optional
  peers and pulls react/react-dom into the backend image. To check an image, list its files
  (`docker run --rm --entrypoint find <image> /app -maxdepth 3`): no `tests/`, `*.md`,
  `Dockerfile*`, `.claude` or host `uploads`.
  `@sab/shared` is built inside the image from the clean tree (the backend image has a `shared-build`
  stage; the frontend's `prebuild` builds it), never copied from the host. To reproduce what Coolify
  builds on a dev machine: `docker compose -f coolify.compose.yml build` (it needs the compose
  variables; do not paste the rendered config anywhere).
- **Rollback of the workspace move**: redeploy the last `main` commit before it in Coolify
  (the one-commit revert on `dev` restores the per-package lockfiles and `./backend` /
  `./frontend` contexts). The registry tags below are for infrastructure disasters only.
- **Rollback** (both services together): revert the change that introduced `build:` in
  `coolify.compose.yml`, i.e. restore
  `image: 127.0.0.1:5000/sab-store-{backend,frontend}:migrated-260921` with
  `pull_policy: always` and delete the `build:` blocks, then deploy. Keeping `build:` next to
  `image:` would rebuild the new code under the old tag instead of rolling back. Data written by
  newer code (e.g. `Settings.storeTitle`) is ignored by the older images.
- **Object storage**: service `sabstore-seaweedfs` (SeaweedFS, S3 API on 9000; on Coolify the
  service name is the network alias, so it is fixed in the compose file and in nginx). Data is
  the bind `/srv/appdata/vol/sab-store_seaweedfs_data`. Its start-up script refuses to run when
  `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` are empty, `minioadmin`, shorter than 16 characters,
  or contain `"`/`\` — a container that will not start after deploy means fix those values. The
  backend's `MINIO_ENDPOINT` is hardcoded in the compose file, so delete any old
  `MINIO_ENDPOINT` from the Coolify environment. Only a first deploy on an empty database also
  needs `INIT_EMPTY_DATABASE=<database name>` (see `docs/ENV_SETUP.md`).
- **Storage vacuum**: deleted images free space only after a vacuum. Inside the storage
  container run `weed shell`, then `volume.vacuum -garbageThreshold 0.1`.
- **Rollback of the storage change** (independent of the two-image rollback above): `git revert`
  the compose and nginx change and deploy. The old MinIO bind directory is deliberately left in
  place, so the previous service starts on its old data. Images uploaded while SeaweedFS was
  live are NOT in the MinIO data; copy them across by hand (e.g. with `mc`/`weed`) before
  rolling back, or they are lost.

### PostgreSQL (the production database since 2026-10-13)

- **Services**: `sabstore-postgres` (data in the bind `/srv/appdata/vol/sab-store_postgres_data`)
  and the one-shot `sabstore-release`. On every deploy the release job writes a `pg_dump -Fc` to
  `/srv/appdata/vol/sab-store_pg_backups` (0600, newest 14 kept), then runs
  `prisma migrate deploy`; the backend starts only after it exits 0. A failed dump stops it
  before any migration, and the backend then stays down: read the job's log
  (`docker logs` on the container with label `com.docker.compose.service=sabstore-release`).
- **Credentials**: `SAB_PG_USER`, `SAB_PG_PASSWORD`, `SAB_PG_DB` in the Coolify environment,
  build-time off. The data directory is initialised once, so changing `SAB_PG_PASSWORD` alone
  locks the backend out. Rotate in this order: inside the postgres container
  `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c '\password'` (the new value never touches argv),
  then the Coolify variable, then deploy.
- **Restore a release dump** (data loss or corruption only; everything written after that dump
  is lost): stop the backend container, then
  `docker exec -i <postgres> sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error' < <dump>`,
  then start the backend. Day-to-day backups are the admin dashboard's export/import.
- **There is no way back to MongoDB.** No code, service or variable for it remains. To undo a
  release, redeploy the previous `main` commit in Coolify; to undo a data migration, also restore
  an admin export (Admin → Database). The old Mongo data directory stays untouched on the host at
  `/srv/appdata/vol/sab-store_mongodb_data`, and a final `mongodump` archive is kept under
  `~/backups/sab-store/`; neither is read by anything.
- **`JWT_SECRET`** is better-auth's secret: it signs the session cookies and encrypts the jwks
  signing key stored in the database. Changing only the variable makes every session check answer
  500, because the stored key no longer decrypts. Rotate it as one step: new value (64 hex,
  `openssl rand -hex 32`; better-auth warns below about 120 bits of estimated entropy) into the
  password manager and the Coolify variable, stop the backend, empty `jwks`, `session` and
  `verification` in one transaction, then deploy. The first authenticated request mints a new
  key; everyone, the admin included, has to sign in again. The SMTP password (Settings page) is
  encrypted with a key derived from `JWT_SECRET`, so after a rotation the stored one no longer
  decrypts, order mail stays off, and the admin re-enters the password.

### Releasing storefronts and email sign-in

The migration `20261025120000_storefronts` (`backend/prisma/migrations/`) runs in the release job,
after its `pg_dump`, like any other. It creates the default storefront and moves every existing
product, combo and online order into it. Order of work:

1. Coolify environment: delete `APPSCRIPT_URL` (and `GOOGLE_CLIENT_ID`, now an admin setting,
   see `docs/ENV_SETUP.md`). Confirm SMTP is on in the admin Settings page: email-code sign-in
   needs it.
2. Deploy (see the downtime note above).
3. Checks, anonymous unless stated:
   - the release job exited 0 and the backend is up;
   - the default storefront exists (admin storefront list) and the product count equals the
     count taken before the deploy;
   - the public shop shows the same products and prices as before, with no sign-in;
   - requesting a sign-in code for a test address delivers the mail (SMTP on only).
4. Staff emails. Staff accounts made before this release are stored with an unverified email, so
   code and Google sign-in refuse them (fail closed) and they keep using their password. To enable
   the new methods for them, in `tmux` on the server, inside the backend container:
   `node scripts/verify-staff-emails.js` (dry run: username, role, masked email, no writes).
   The owner reads the list, fixes any placeholder or mistyped address in the admin UI (whoever
   owns that mailbox could otherwise sign in as that staff member), and only then runs
   `node scripts/verify-staff-emails.js --apply --only=<username,...>` (`--all` verifies every
   unverified account). Accounts left out keep working with their password.

Rollback is the usual one (redeploy the previous `main` commit); the migration is additive, but
anything written to storefront tables is ignored by the older code.

## After pulling the workspace move (dev machines)

- **Every machine** (Mac and Windows, they share the working tree through Syncthing): wait for
  Syncthing to report "Up to Date", run `pnpm install` once at the repository root **before any
  git command that runs a hook** (the hooks call `pnpm`/Vitest against the tree and would test a
  half-migrated one), then `git reset` (the index is per machine) and check that `HEAD` and
  `git status` are clean. Old `backend/node_modules` and `frontend/node_modules` are replaced by
  workspace links; delete them first if pnpm complains.
- **Dev compose stack** (`compose.yml`): the backend's `/app/node_modules` volume is now
  `backend_deps`. The old `backend_node_modules` volume is no longer used; remove it with
  `docker volume rm <project>_backend_node_modules` if you want the space back (never
  `down -v`, which also drops the dev database and storage volumes). The frontend's anonymous `/app/node_modules` volume is created empty by every `up`, so
  it cannot hold a stale copy.
- **Dependencies are frozen** between the commit that introduces the workspace and the deploy
  that confirms it: do not add or upgrade a package on any branch in that window, so a lockfile
  difference cannot be mistaken for a build problem.

## Architecture in one paragraph

Single ingress: `store.sabies.vn` → NPM → `frontend` container (nginx, built from
`frontend/Dockerfile`) → `/api/*` proxied to `backend:5000`, `/uploads/*` proxied directly to
`sabstore-seaweedfs:9000` (internal Docker network, never the public internet). There is no separate
`nginx` service and no `api.store.sabies.vn` route — see `prod.compose.yml` (services
`sabstore-postgres`, the one-shot `sabstore-release`, `sabstore-redis`,
`sabstore-seaweedfs`, `backend`, `frontend`). `backend/server.js:48` sets
`trust proxy` to `2` (NPM → frontend nginx → backend).

## 0. Prerequisites — read before touching the server

1. **`.env` must be complete before `up -d`.** Every secret in `prod.compose.yml` uses
   `${VAR:?message}` (`PUBLIC_URL`, `JWT_SECRET`, `SAB_PG_USER`, `SAB_PG_PASSWORD`, `SAB_PG_DB`,
   `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `REDIS_PASSWORD`; `ADMIN_*` are optional, read only to
   create the first admin). A missing one means the container
   **will not boot** — this is by design (fail-fast), not a bug to work around. Same is true
   inside the backend process itself: `backend/lib/auth.js` throws at `require()` time if
   `JWT_SECRET` or `DATABASE_URL` are missing or `JWT_SECRET` is short/placeholder-looking.
   Preflight check: `docker compose -f prod.compose.yml exec -T backend node check-env.js`
   (reports each required var as set/MISSING, never prints values, fails loudly on a
   placeholder-looking `JWT_SECRET`).
2. `CORS_ORIGIN` and `BASE_URL` are **not** set independently anymore — `prod.compose.yml`
   interpolates both from `PUBLIC_URL`. Set `PUBLIC_URL=https://store.sabies.vn` and nothing
   else for origin config.
3. Frontend needs no runtime env var — `VITE_API_URL` was deleted, not renamed. The SPA calls
   the API via the relative path `/api`, resolved by whatever domain served the page.

## 1. Push first

Server pulls from git, not from your working tree.

```sh
git status -sb && git push origin main
```

## 2. Baseline — before touching anything

```sh
ssh -p 24700 david0403@ssh.noboroto.id.vn
cd ~/github/SAB-Store
cp .env .env.bak-$(date +%Y%m%d-%H%M)
git log --oneline -1
docker compose -f prod.compose.yml exec -T sabstore-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "
  select '"'"'orders'"'"', count(*) from orders union all select '"'"'products'"'"', count(*) from products
  union all select '"'"'combos'"'"', count(*) from combos union all select '"'"'user'"'"', count(*) from \"user\""' | tee /tmp/baseline.txt
```

Verify the database is the real one (`SAB_PG_DB`), not an empty or seed one.

## 3. Update `.env` on the server

Edit the server's `.env` (not `.env.example`) so it has every var listed in step 0.1. Add
`PUBLIC_URL=https://store.sabies.vn`; remove any leftover `CORS_ORIGIN`, `BACKEND_URL`,
`REACT_APP_API_URL`, `VITE_API_URL` lines (dead, but harmless if left — `prod.compose.yml`
no longer reads them for origin config).

Rotating `SAB_PG_PASSWORD` follows the order in the PostgreSQL section above (change it inside
the running database first, then `.env`).

## 4. Dry run the compose config

```sh
docker compose -f prod.compose.yml config > /dev/null && echo "CONFIG OK"
```

Fails loudly (naming the missing var) if step 3 left anything out.

## 5. Build and deploy — in tmux, one service at a time

Host has ~413 Mi free, 4 vCPU, 0 swap, shared with ~40 containers from other projects.
Building both services in parallel can OOM and kill containers that belong to unrelated
projects on the same host.

```sh
tmux new-session -d -s deploy 'cd ~/github/SAB-Store && \
  git pull --ff-only && \
  docker compose -f prod.compose.yml build backend && \
  docker compose -f prod.compose.yml build frontend && \
  docker compose -f prod.compose.yml up -d 2>&1 | tee /tmp/deploy.log'
```

Frontend **must** be rebuilt (`build frontend`, not skipped) — it is a static bundle baked at
build time; restarting the container without rebuilding serves the old JS/CSS.

Points that matter:
- Always `-f prod.compose.yml`. The bare `compose.yml` is the dev stack (bind mounts, PostgreSQL
  published to the host).
- `up -d` with **no service name suffix** — naming one narrows the scope and `restart: true`
  on the un-named services doesn't get evaluated, so e.g. frontend can keep its old backend
  connection cached.
- If tmux dies mid-deploy, check `dmesg -T | grep -i oom` **before** assuming an SSH drop —
  the symptoms look identical, and re-running the same command will OOM again if it was OOM.

## 6. Verify (independent of exit codes)

| # | Check | Pass when |
|---|---|---|
| 1 | New code is live | `git log --oneline -1` on server matches what was pushed |
| 2 | Containers recreated | `docker ps` shows `Up X seconds`, not `Up N days` |
| 3 | Data untouched | re-run the count query from step 2, matches `/tmp/baseline.txt` |
| 4 | Storage closed | `curl http://<server-ip>:9000/` and `:9001/` from an external machine → refused |
| 5 | Old API domain gone | `curl https://api.store.sabies.vn/api/products` → does not resolve / NPM 404 |
| 6 | Anonymous upload blocked | `POST /api/upload/product-image` with no cookie → 401/403 |
| 7 | Role escalation closed | sign up with `role:"admin"` in the body → stored role is `user` |
| 8 | Server-side pricing | `POST /api/orders` with `finalTotal: 0` → DB stores the real computed total |
| 9 | Security headers | `curl -I https://store.sabies.vn/uploads/<known image>` → `X-Content-Type-Options: nosniff` |
| 10 | Manual smoke | browse products, place an order, admin login, seller direct sale, image upload |

Retire `api.store.sabies.vn` (NPM proxy host, historically `43.conf`) by disabling it, not
deleting — watch its access log for a week for any legitimate traffic before deleting the
host entirely.

## 7. Promote the CSP from report-only to enforcing

`frontend/security-headers.conf` ships `Content-Security-Policy-Report-Only`, not
`Content-Security-Policy` — it has not been verified against a real browser yet, and a wrong
enforcing policy takes the storefront down.

1. After deploy, open `store.sabies.vn` in a browser, DevTools → Console.
2. Exercise: storefront browse, checkout, admin login + product edit, seller direct sale,
   image upload/preview.
3. If no `[Report Only]` CSP violation appears in the console for any of the above, edit
   `frontend/security-headers.conf`: rename the header from
   `Content-Security-Policy-Report-Only` to `Content-Security-Policy`, rebuild and redeploy
   the `frontend` service (step 5, frontend only).
4. If a violation does appear, add the specific origin/directive it names — do not widen the
   policy generically (e.g. do not re-add `'unsafe-inline'`/`'unsafe-eval'` wholesale).

## 8. Enable rate limiting — only after verifying `req.ip`

Rate limiting exists (`authLimiter`, `orderLimiter`, `publicLimiter` in `backend/server.js`)
but is **off by default**, gated behind `RATE_LIMIT_ENABLED` (`backend/server.js`,
`if (process.env.RATE_LIMIT_ENABLED === 'true')`). `req.ip` is resolved by a CIDR trust list
(`backend/lib/trusted-proxies.js`: `loopback` + `10.0.0.0/16`, override with
`TRUSTED_PROXY_IPS`), and frontend nginx restores the visitor address with the same range
(`set_real_ip_from` in `frontend/nginx.conf`). Coolify assigns the project network subnet; if
it ever falls outside `10.0.0.0/16`, change both together or every client collapses onto one
IP bucket and the whole site gets 429'd.

Quick check after a deploy (no second network needed):

```sh
curl -s -o /dev/null -H "X-Forwarded-For: 9.9.9.9" https://store.sabies.vn/api/settings
docker logs --tail 5 <frontend container>   # first token = your public IP, not 10.0.x.x, not 9.9.9.9
docker logs --tail 5 <backend container>    # {"type":"access","ip":...} = the same public IP
```

Verify from **two different external networks** (not the same NAT) before setting
`RATE_LIMIT_ENABLED=true`:

```sh
# From network A, then from network B:
curl -s -o /dev/null https://store.sabies.vn/api/__not-a-real-route__
```

Then check the backend log for the two `404 - Route not found` entries (this handler always
logs via `console.warn`, regardless of `NODE_ENV` — see `backend/server.js`'s catch-all route
and `middleware/logger.js`):

```sh
docker compose -f prod.compose.yml logs backend | grep "404 - Route not found"
```

Confirm the two log lines show two **different** `ip` values. If they show the same value
(e.g. the frontend container's internal IP), do not enable rate limiting — the proxy trust list
does not match the real chain and needs fixing in `backend/lib/trusted-proxies.js` / `frontend/nginx.conf` first. Only after two distinct real IPs are
confirmed: set `RATE_LIMIT_ENABLED=true` in `.env`, redeploy backend (step 5, backend only).

## Operator scripts

Operator scripts live in `backend/scripts/` and are invoked manually, on the server, by whoever
decides to run them.

### `backend/scripts/audit-combo-pricing.js` — read-only

Finds stored orders whose `comboInfo` may have been priced by the pre-fix combo bug
(`Combo.getMaxApplications()` treating an unmet category requirement as "not yet set"
instead of a real zero). Issues no writes, prints order codes only, never names or student
IDs.

```sh
docker exec sab-store-backend-1 node scripts/audit-combo-pricing.js
```

### Checking a share preview

The share pages get their `<head>` tags from an nginx SSI subrequest; every failure falls back
to the generic store tags. To check one product after a deploy:

```sh
curl -s -A 'facebookexternalhit/1.1' https://store.sabies.vn/p/<CODE>/x | grep -o 'og:[a-z]*" content="[^"]*"'
```

`og:title` must be the product name and `og:image` an `/og/p/<CODE>.jpg?v=…` URL that answers
`image/jpeg`. The preview cache lives in the frontend container, so every deploy (which
recreates it) starts cold; social networks keep their own copy, so use the Facebook Sharing
Debugger to refresh a link that was shared before a change.

### Logs

The `frontend` and `sabstore-backend` services carry the labels `logging: david-alloy`,
`logging.project: sab-store` and `logging.service: frontend|backend`; the shared Alloy on the
host ships only labelled containers to the shared Loki. Both write one JSON object per line.
Secrets are never logged: the order code in `/api/orders/<code>` is rewritten to
`/api/orders/:code` and query strings are dropped, in nginx and in the backend alike. Scanner
probes (`/.env`, `*.php`, …) get an unlogged 404 straight from nginx.

## Operational consequences

- **Admin's DB export no longer contains `users`/`accounts`**
  (`GET /api/admin/database/export`, `backend/routes/admin/database.js`) — no password
  hashes, session tokens, or account records leave the system through that endpoint. The
  file covers products, combos, orders, stock movements and settings, and can be loaded back
  from the admin page "Quản lý Database" (Khôi phục replaces the store's data; Nhập gộp
  without overwriting). Accounts are never part of it.
- **Storage is SeaweedFS, not MinIO.** The upstream `minio/minio` repository was archived
  2026-04-25 and stopped shipping free images, so it no longer receives fixes. The compose
  files pin `chrislusf/seaweedfs` by digest; updating it means choosing a new tag and digest
  deliberately.
- Multi-step writes (order + stock) run in one PostgreSQL transaction; external calls happen
  only after it commits.

## Rollback

No schema migrations to reverse — each phase of this hardening effort merged as its own merge
commit on `main` (`git log --oneline --merges`). To roll back, check out the merge commit
before the one you want to undo, rebuild, and redeploy:

```sh
git checkout <merge commit before the phase to undo>
docker compose -f prod.compose.yml build backend && \
docker compose -f prod.compose.yml build frontend && \
docker compose -f prod.compose.yml up -d
cp .env.bak-<timestamp> .env   # only if .env was changed since that commit
```

Volumes are untouched by any of this. To undo a data migration as well, restore an admin export
(Admin → Database) or, for data loss, a release dump (see the PostgreSQL section).
