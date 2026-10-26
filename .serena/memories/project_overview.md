# SAB-Store — Project overview

Hệ thống bán lanyard/merch cho sinh viên (SAB): khách đặt online và theo dõi đơn; admin quản lý
sản phẩm/combo/seller/đơn, dashboard, import/export DB; seller bán trực tiếp (POS) và xem đơn;
thanh toán chuyển khoản VietQR; email xác nhận đơn qua SMTP do admin cấu hình (mặc định tắt). Gian hàng (storefront) công khai/riêng tư với quy tắc truy cập theo email/tên miền/danh sách; khách đăng nhập bằng mã email (cần SMTP) hoặc Google One Tap (Client ID nhập ở trang Cài đặt admin); staff vẫn dùng mật khẩu. Hướng dẫn admin: `docs/storefronts.md`.

Stack (version: đọc `package.json` / Dockerfile / compose, không ghi ở đây):
- `backend/`: Express + Mongoose (MongoDB), Better Auth (username/password, session, role admin/seller),
  object storage SeaweedFS (S3 API, SDK `minio`, biến `MINIO_*`) cho file, Vitest + mongodb-memory-server.
- `frontend/`: React + Vite + React Router + Tailwind, Vitest; nginx trong container phục vụ SPA và proxy `/api`.
- Deploy: `coolify.compose.yml` trên Coolify (nhánh `main`); `compose.yml` dev; `prod.compose.yml` rollback.

Cấu trúc chi tiết: tự tra bằng `get_symbols_overview` / code-review-graph, đừng chép vào memory.
