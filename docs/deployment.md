# Deploy runbook

Authoritative deploy procedure for SAB-Store production (`store.sabies.vn`). Supersedes the
step lists in `DEPLOYMENT_UPDATE.md` (that file is a historical record of one earlier
migration, kept for context, not a deploy guide).

A human runs every step below. Nothing here is automated.

## Architecture in one paragraph

Single ingress: `store.sabies.vn` → NPM → `frontend` container (nginx, built from
`frontend/Dockerfile`) → `/api/*` proxied to `backend:5000`, `/uploads/*` proxied directly to
`minio:9000` (internal Docker network, never the public internet). There is no separate
`nginx` service and no `api.store.sabies.vn` route — see `prod.compose.yml` (4 services:
`mongodb`, `minio`, `backend`, `frontend`). `backend/server.js:48` sets
`trust proxy` to `2` (NPM → frontend nginx → backend).

## 0. Prerequisites — read before touching the server

1. **`.env` must be complete before `up -d`.** Every secret in `prod.compose.yml` uses
   `${VAR:?message}` (`PUBLIC_URL`, `JWT_SECRET`, `MONGODB_URI`, `MONGO_INITDB_ROOT_USERNAME`,
   `MONGO_INITDB_ROOT_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `ADMIN_EMAIL`,
   `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `APPSCRIPT_URL`). A missing one means the container
   **will not boot** — this is by design (fail-fast), not a bug to work around. Same is true
   inside the backend process itself: `backend/lib/auth.js` throws at `require()` time if
   `JWT_SECRET`/`MONGODB_URI` are missing or `JWT_SECRET` is short/placeholder-looking.
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
docker compose -f prod.compose.yml exec -T mongodb mongosh -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval '
  ["orders","products","combos","accounts"]
    .forEach(c=>print(c+": "+db.getSiblingDB("sablanyard")[c].countDocuments()))' | tee /tmp/baseline.txt
```

Verify the DB name is the real one (`sablanyard`), not the seed database (`minipreorder`) —
see `plans/reports/correction-260914-1515-database-thuc-te-va-ket-qua-hotfix.md` for why that
distinction matters here.

## 3. Update `.env` on the server

Edit the server's `.env` (not `.env.example`) so it has every var listed in step 0.1. Add
`PUBLIC_URL=https://store.sabies.vn`; remove any leftover `CORS_ORIGIN`, `BACKEND_URL`,
`REACT_APP_API_URL`, `VITE_API_URL` lines (dead, but harmless if left — `prod.compose.yml`
no longer reads them for origin config).

**Rotating the Mongo password — order matters.** `MONGO_INITDB_ROOT_PASSWORD` only seeds the
user on first container creation; changing it in `.env` against an **existing** data volume
is a no-op and just breaks `MONGODB_URI` for the backend. Correct order:

```sh
# 1. Change the password on the running DB first
docker compose -f prod.compose.yml exec -T mongodb mongosh -u "$MONGO_INITDB_ROOT_USERNAME" -p "<old password>" --authenticationDatabase admin --eval '
  db.getSiblingDB("admin").changeUserPassword("'"$MONGO_INITDB_ROOT_USERNAME"'", "<new password>")'
# 2. Only then update .env: MONGO_INITDB_ROOT_PASSWORD and the password embedded in MONGODB_URI
# 3. Verify connectivity before moving on
docker compose -f prod.compose.yml exec -T backend node -e "require('mongoose').connect(process.env.MONGODB_URI).then(()=>{console.log('OK');process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"
```

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
- Always `-f prod.compose.yml`. The bare `compose.yml` is the dev stack (bind mounts, Mongo
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
| 4 | MinIO closed | `curl http://<server-ip>:9001/` from an external machine → refused |
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
but is **off by default**, gated behind `RATE_LIMIT_ENABLED` (`server.js:137`,
`if (process.env.RATE_LIMIT_ENABLED === 'true')`). `trust proxy` is hardcoded to `2` for
production. If the real hop count from `store.sabies.vn` to the backend is ever different,
every client collapses onto one IP bucket and the whole site gets 429'd.

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
(e.g. the frontend container's internal IP), do not enable rate limiting — the hop count is
wrong and needs fixing in `server.js:48` first. Only after two distinct real IPs are
confirmed: set `RATE_LIMIT_ENABLED=true` in `.env`, redeploy backend (step 5, backend only).

## Operator scripts

Neither of these ran as part of this hardening pass. Both live in `backend/scripts/` and are
invoked manually, on the server, by whoever decides to run them.

### `backend/scripts/audit-combo-pricing.js` — read-only

Finds stored orders whose `comboInfo` may have been priced by the pre-fix combo bug
(`Combo.getMaxApplications()` treating an unmet category requirement as "not yet set"
instead of a real zero). Issues no writes, prints order codes only, never names or student
IDs.

```sh
docker exec -e MONGODB_URI="$MONGODB_URI" sab-store-backend-1 \
  node scripts/audit-combo-pricing.js
```

### `backend/scripts/backfill-stock-deducted.js` — dry-run by default

Backfills the new `Order.stockDeducted` field on orders created before this field existed,
using the rule `stockDeducted = (order.isDirectSale === true)` (derivation in the script's
own header comment). Idempotent — only touches documents missing the field.

```sh
# Dry run (default, no writes, prints counts only):
docker exec -e MONGODB_URI="$MONGODB_URI" sab-store-backend-1 \
  node scripts/backfill-stock-deducted.js
# Apply, only after reviewing the dry-run counts:
docker exec -e MONGODB_URI="$MONGODB_URI" sab-store-backend-1 \
  node scripts/backfill-stock-deducted.js --apply
```

## Operational consequences

- **Admin's DB export no longer contains `users`/`accounts`**
  (`GET /api/admin/database/export`, `backend/routes/admin/database.js`) — no password
  hashes, session tokens, or account records leave the system through that endpoint. It
  covers `products`/`combos`/`orders` only. For a full-system backup including
  credentials/sessions, use `mongodump` against the `mongodb` container directly; there is no
  HTTP path for that anymore, by design.
- **MinIO patching now requires self-building the image.** The upstream `minio/minio`
  repository was archived 2026-04-25 and Docker Hub stopped receiving free pre-built images
  in Oct 2025. `prod.compose.yml` pins `minio/minio:RELEASE.2025-10-15T17-29-55Z`, the last
  published release. Any future MinIO CVE fix will need to be built from MinIO's source per
  their own current guidance — there is no next tag to pull.
- Production runs **no replica set** (AD-4 in `plan.md`). Do not add `session`/transactions
  to any Mongo write path — `services/stock.js` and the DB import path both accept an
  optional `session` for a future replica set, but neither uses one today, and a
  `mongoose.startSession()` call will throw at runtime without one. The Jest harness runs
  against `mongodb-memory-server`'s replica-set mode, so a transaction would pass in tests and
  crash in production — this asymmetry is intentional to flag, not a gap to silently fix.

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

Volumes are untouched by any of this. There is no replica set to roll back (none exists in
prod).
