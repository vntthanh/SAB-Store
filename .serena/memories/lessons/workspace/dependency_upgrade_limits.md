# Dependency/image upgrade — giới hạn đã đo (10/10/2026)

- **better-auth > 1.3.8 không chạy được dưới Jest 29**: từ 1.3.10 kéo `jose` 6 + `@noble/*` 2 (ESM-only); từ 1.4.0 chính better-auth chỉ còn `.mjs`. Node 24 `require()` được ESM (production ổn), nhưng Jest 29 báo "Cannot use import statement outside a module" → 70/70 suite đỏ. Backend pin chính xác `1.3.8`; frontend `~1.3.34` (Vite, không ảnh hưởng).
  Lên 1.7 cần: Jest có `require(esm)` (Jest 30 mới + `--experimental-vm-modules` + Node ≥ 24.9, theo docs Jest) và kiểm migration schema auth. 1.3.8 còn advisory core (rate limiter IPv6 < 1.4.17, basePath DoS < 1.4.2); `backend/lib/auth.js` không cấu hình `rateLimit` → mặc định bật ở production.
- **Ảnh dùng chung trên david-host** (host Coolify của SAB; JudgeHub/Leaderboard ở judge-server khác): node `24.21.0-alpine3.23@9ec4a2e2` (QR, SAB-Delegate), redis `8.10.2-alpine@72cedd96` (QR), seaweedfs 4.47 (QR). nginx trên host `62ff2089` là bản build cũ của 1.31.6; SAB giữ `df221db8`. Hỏi phiên Coolify (`ListAgents`, ref máy local) để biết hiện trạng.
- **Redis 8**: đọc được AOF của 7.4 (đã thử key/list/stream); một chiều — rollback 7.x phải chạy trên data dir rỗng. Rảnh ~48 MiB (7.4 ~18) → `mem_limit` 192m.
- mongo production 6.0.28, rs0, FCV 6.0 — lên 7/8 phải từng major, set FCV sau mỗi bước, mongodump trước.
