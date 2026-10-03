# Dựng stack kiểm thử từ compose.yml (dev) để xem UI thật

Lệnh đã chạy được (cổng theo quy ước SAB, ghi vào `/tmp/cc-ports.registry` trước):
`JWT_SECRET=$(openssl rand -hex 32) ADMIN_PASSWORD='<mạnh>' NGINX_PORT=8088 MONGODB_PORT=27117 PUBLIC_URL=http://localhost:8088 docker compose -p sabstore-verify up -d --build` (build = việc nặng → qua khoá máy).

Cạm bẫy đã đo:
- Mặc định `JWT_SECRET` trong compose.yml < 32 ký tự → `backend/lib/auth.js` throw lúc boot, backend restart loop. Luôn truyền secret dùng một lần.
- `frontend/nginx.conf` proxy tới `sabstore-backend` (tên service của coolify.compose.yml), còn compose.yml tên service là `backend` → nginx 502 "could not be resolved". Gắn alias: `docker network disconnect sabstore-verify_sabstore_network sabstore_backend && docker network connect --alias sabstore-backend --alias backend sabstore-verify_sabstore_network sabstore_backend`.
- Cổng 5000 trên Mac do AirPlay Receiver (ControlCenter) chiếm → không chạy backend trần trên host ở :5000.
- Admin login: username `admin`, mật khẩu = `ADMIN_PASSWORD` đã truyền. Checkout: thêm sản phẩm rồi bấm link "Xác nhận"; `goto('/checkout')` thẳng bị đẩy về `/` vì giỏ chưa nạp.
- Dọn: `docker compose -p sabstore-verify down -v` + xoá dòng 8088/27117 khỏi registry.

**Why:** đo 03/10/2026 khi kiểm editor lời nhắc trong admin Settings.
**How to apply:** dùng khi cần kiểm hành vi UI production-like; đừng sửa compose.yml chỉ để chạy kiểm thử.
