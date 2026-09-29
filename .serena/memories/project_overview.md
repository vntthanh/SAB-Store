# SAB-Store — Project overview

Hệ thống bán lanyard/merch cho sinh viên (SAB): khách đặt online và theo dõi đơn; admin quản lý
sản phẩm/combo/seller/đơn, dashboard, import/export DB; seller bán trực tiếp (POS) và xem đơn;
thanh toán chuyển khoản VietQR; email xác nhận qua AppScript.

Stack (version: đọc `package.json` / Dockerfile / compose, không ghi ở đây):
- `backend/`: Express + Mongoose (MongoDB), Better Auth (username/password, session, role admin/seller),
  MinIO cho file, Jest + mongodb-memory-server.
- `frontend/`: React + Vite + React Router + Tailwind, Vitest; nginx trong container phục vụ SPA và proxy `/api`.
- Deploy: `coolify.compose.yml` trên Coolify (nhánh `main`); `compose.yml` dev; `prod.compose.yml` rollback.

Cấu trúc chi tiết: tự tra bằng `get_symbols_overview` / code-review-graph, đừng chép vào memory.
