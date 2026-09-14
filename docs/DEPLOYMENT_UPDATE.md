# Deployment Update - MinIO Direct Access

> Historical record of one migration (nginx serving `/uploads/` straight from MinIO instead of
> proxying through the backend). Kept for context; **not** the current deploy procedure — see
> `docs/deployment.md` for that. One claim below was wrong and has since been reverted for
> security; corrected inline.

## Changes Made

### 1. Architecture Update
- **Before**: Frontend → Nginx → Backend → MinIO
- **After**: Frontend → Nginx → MinIO (direct)

### 2. Benefits
- ✅ Reduced latency for image loading
- ✅ Less backend load
- ✅ Better performance with nginx caching
- ✅ Direct streaming from object storage

### 3. Files Modified

#### `frontend/nginx.conf`
```nginx
location /uploads/ {
    # Remove /uploads prefix and proxy to MinIO bucket
    rewrite ^/uploads/(.*)$ /sabstore/$1 break;
    
    proxy_pass http://minio:9000;
    # ... MinIO specific configurations
}
```

#### `backend/server.js`
- Removed `/uploads/*` endpoint
- MinIO streaming now handled by Nginx

#### `prod.compose.yml`
- **Corrected claim**: this file originally said MinIO was changed from `expose` to `ports`
  "to allow Nginx access" — that was technically wrong and, as written, described a real
  security hole (MinIO's console reachable from the public internet, closed by the Phase 00
  hotfix). Nginx reaches MinIO over the internal Docker network (`sabstore_network`); `expose`
  is sufficient, `ports` is not needed and is not used. Current `prod.compose.yml` keeps
  MinIO on `expose: ["9000", "9001"]` only — never published to the host.

#### `backend/lib/minio.js`
- Policy now applied on every startup (not just creation)
- Ensures bucket always has public read access

## Deployment steps, troubleshooting, rollback

Removed from this file — they described `docker compose down` before redeploying (now
forbidden, see `docs/deployment.md`), a nonexistent `.env.prod` file (the repo uses one root
`.env`), and told operators to open the MinIO console at `:9001` from a browser, which
directly contradicts the "Security Notes" below and the Phase 00 hotfix that closed that port
to the public internet. Use `docs/deployment.md` for the current, correct procedure.

## Security Notes

- MinIO bucket has public read-only access
- Write access only via backend API with authentication
- Nginx acts as reverse proxy with security headers
- No direct MinIO console access from public internet
