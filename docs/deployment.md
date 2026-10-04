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
- **No deployment appeared after a push**: the webhook was not delivered (it happened on
  2026-09-29). Check the repo's Settings → Webhooks → Recent Deliveries and redeliver, or press
  Deploy in the Coolify UI.
- **Build-time variables**: Coolify injects every variable marked "Available during build" as an
  `ARG` into every Dockerfile stage. Keep secrets NOT available during build; the Dockerfiles
  pass `--production` explicitly so an injected `NODE_ENV` cannot change what gets installed.
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

### Copying the database under a new name

The production database is `sabstore` (it was `sablanyard` until 2026-09-29; that copy is kept
read-only for a while as the rollback). To copy a database under a new name again, on the
server, inside `tmux`, with the backend stopped:

1. Pick containers by Coolify labels, never by a name pattern (the host runs many projects):
   `docker ps --filter label=com.docker.compose.service=<service> --filter label=<coolify project label>`.
   Stop exactly the one backend container and confirm `db.currentOp()` shows nothing from it.
2. Save the helper below as `db-rename.sh`. It authenticates with the mongo container's own
   `MONGO_INITDB_ROOT_*` variables, so no password appears in argv, `ps` or shell history; the
   dump/restore credentials live in a 0600 temp file removed on exit.
3. `snapshot FROM TO` (read-only; aborts if TO exists) → `copy FROM TO` → `compare FROM TO`
   (document counts and index keys per collection must print `MATCH`). On `MISMATCH`:
   `drop-target FROM TO`, restart the backend on the old URI, stop.
4. Change the path of `MONGODB_URI` (and `MONGO_INITDB_DATABASE`) in the Coolify environment,
   then deploy. The backend refuses to start on a database without users, so a typo in the
   name fails loudly; mongoose still creates empty collections for indexes there — drop that
   stray database afterwards.
5. Rollback is only safe while the store is still closed: point `MONGODB_URI` back. Once new
   orders land in the new database, fix forward instead of copying back.

```bash
#!/bin/bash
# Usage: db-rename.sh <mongo-container> <snapshot|copy|compare|drop-target> FROM TO
set -euo pipefail
M=$1; ACTION=$2; FROM=$3; TO=$4
msh() { docker exec -i -e FROM="$FROM" -e TO="$TO" "$M" mongosh --nodb --quiet --file /dev/stdin; }
AUTH='const conn = new Mongo("mongodb://localhost:27017"); const admin = conn.getDB("admin"); admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);'
SNAP='function snap(name){ const d = conn.getDB(name); const out = {}; d.getCollectionNames().sort().forEach(c => { out[c] = { count: d.getCollection(c).countDocuments({}), indexes: d.getCollection(c).getIndexes().map(i => JSON.stringify(i.key) + (i.unique ? "!u" : "")).sort() }; }); return out; }'
case "$ACTION" in
  snapshot) echo "$AUTH $SNAP
    const names = admin.adminCommand({listDatabases:1}).databases.map(d => d.name);
    if (names.includes(process.env.TO)) { print('ABORT: target ' + process.env.TO + ' already exists'); quit(2); }
    print(JSON.stringify(snap(process.env.FROM)));" | msh ;;
  copy) docker exec -i -e FROM="$FROM" -e TO="$TO" "$M" bash -c 'set -euo pipefail
    umask 077; CFG=$(mktemp)
    trap "rm -f $CFG" EXIT
    printf "uri: mongodb://%s:%s@localhost:27017/?authSource=admin\n" "$MONGO_INITDB_ROOT_USERNAME" "$MONGO_INITDB_ROOT_PASSWORD" > "$CFG"
    mongodump --config="$CFG" --db="$FROM" --archive --quiet \
      | mongorestore --config="$CFG" --archive --nsFrom="$FROM.*" --nsTo="$TO.*" --quiet
    echo "copy done"' ;;
  compare) echo "$AUTH $SNAP
    const a = JSON.stringify(snap(process.env.FROM)), b = JSON.stringify(snap(process.env.TO));
    print(a === b ? 'MATCH ' + Object.keys(snap(process.env.TO)).length + ' collections' : 'MISMATCH\n' + a + '\n' + b);
    if (a !== b) quit(3);" | msh ;;
  drop-target) echo "$AUTH conn.getDB(process.env.TO).dropDatabase(); print('dropped ' + process.env.TO);" | msh ;;
esac
```

## Architecture in one paragraph

Single ingress: `store.sabies.vn` → NPM → `frontend` container (nginx, built from
`frontend/Dockerfile`) → `/api/*` proxied to `backend:5000`, `/uploads/*` proxied directly to
`sabstore-seaweedfs:9000` (internal Docker network, never the public internet). There is no separate
`nginx` service and no `api.store.sabies.vn` route — see `prod.compose.yml` (4 services:
`mongodb`, `sabstore-seaweedfs`, `backend`, `frontend`). `backend/server.js:48` sets
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
    .forEach(c=>print(c+": "+db.getSiblingDB("sabstore")[c].countDocuments()))' | tee /tmp/baseline.txt
```

Verify the DB name is the real one (`sabstore`), not the seed database (`minipreorder`) —
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
- **Storage is SeaweedFS, not MinIO.** The upstream `minio/minio` repository was archived
  2026-04-25 and stopped shipping free images, so it no longer receives fixes. The compose
  files pin `chrislusf/seaweedfs` by digest; updating it means choosing a new tag and digest
  deliberately.
- MongoDB runs as a **single-node replica set `rs0`** (since 2026-10-04) so multi-document
  transactions work. The keyfile comes from the runtime variable `MONGO_REPLICA_KEY`
  (base64, no newlines, 6–1024 chars, e.g. `openssl rand -base64 756 | tr -d '\n'`); the
  healthcheck initiates the set on first start. `MONGODB_URI` carries `replicaSet=rs0`. The
  backend refuses to boot against a standalone mongod, so the Jest harness (also a replica
  set) and production behave the same.

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

Volumes are untouched by any of this. Rolling MongoDB back to standalone: drop
`--replSet`/`--keyFile` from the mongo service and `replicaSet=rs0` from `MONGODB_URI`, and
revert the backend's replica-set startup check (`backend/lib/require-replica-set.js` call in
`backend/lib/database.js`) in the same deploy — otherwise the backend refuses to start.
mongod starts standalone on the same data dir.
