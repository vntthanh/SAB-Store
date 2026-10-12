# Dựng stack kiểm thử từ compose.yml (dev) để xem UI thật

Lệnh đã chạy được (cổng theo quy ước SAB, ghi vào `/tmp/cc-ports.registry` trước):
`JWT_SECRET=$(openssl rand -hex 32) ADMIN_PASSWORD='<mạnh>' NGINX_PORT=8088 MONGODB_PORT=27117 PUBLIC_URL=http://localhost:8088 docker compose -p sabstore-verify up -d --build` (build = việc nặng → qua khoá máy).

Cạm bẫy đã đo:
- Mặc định `JWT_SECRET` trong compose.yml < 32 ký tự → `backend/lib/auth.js` throw lúc boot, backend restart loop. Luôn truyền secret dùng một lần.
- `frontend/nginx.conf` proxy tới `sabstore-backend` (tên service của coolify.compose.yml), còn compose.yml tên service là `backend` → nginx 502 "could not be resolved". Gắn alias: `docker network disconnect sabstore-verify_sabstore_network sabstore_backend && docker network connect --alias sabstore-backend --alias backend sabstore-verify_sabstore_network sabstore_backend`.
- Cổng 5000 trên Mac do AirPlay Receiver (ControlCenter) chiếm → không chạy backend trần trên host ở :5000.
- Admin login: username `admin`, mật khẩu = `ADMIN_PASSWORD` đã truyền. Checkout: thêm sản phẩm rồi bấm link "Xác nhận"; `goto('/checkout')` thẳng bị đẩy về `/` vì giỏ chưa nạp.
- **Stale `backend_deps` volume (measured 2026-10-11):** `compose.yml` mounts the `backend_deps` volume over `/app/node_modules`, so a rebuilt image still runs the OLD `@sab/shared` dist left in the volume. A new export showed up as `undefined` in the container (restore always returned 400) while the tests stayed green. Every time shared changes: `docker volume rm sabstore-verify_backend_deps` before `up`. Check with `docker exec sabstore_backend node -e "console.log(typeof require('@sab/shared').<EXPORT>)"`.
- **Log in through `http://localhost:8088`, not `127.0.0.1`:** better-auth checks the origin against `PUBLIC_URL`, and the wrong host gets 403 on sign-in.
- Playwright MCP only uploads files from the repo or `.playwright-mcp/`, and downloads land in `.playwright-mcp/` (gitignored). Delete them afterwards if they contain production data.
- Dọn: `docker compose -p sabstore-verify down -v` + xoá dòng 8088/27117 khỏi registry.

**Why:** đo 03/10/2026 khi kiểm editor lời nhắc trong admin Settings.
**How to apply:** dùng khi cần kiểm hành vi UI production-like; đừng sửa compose.yml chỉ để chạy kiểm thử.
