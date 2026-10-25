# Cutover Mongo→Postgres: cổng deploy và DB tạm cục bộ

- Pipeline đã duyệt (11/10/2026, "Bạn được phép dùng localhost làm temp database"): mongodump production → Mongo cục bộ → loader → Postgres cục bộ (đúng image + initdb args của prod) → verify → `pg_dump` → `pg_restore` vào Postgres production. Transform và verify không chạy trên server dùng chung; mỗi lần diễn tập giống hệt nhau.
- Dump là dữ liệu khách hàng: chỉ nằm trong `~/backups/sab-store/`, không vào repo hay log.
- Cổng deploy: 11/10 "Lưu ý chưa deploy"; 13/10 00:46 "Làm diễn tập đi, nếu production trong 1h không có ai đăng nhập thì deploy full" → kiểm session/đơn 60 phút gần nhất ngay trước merge, có hoạt động thì chờ rồi kiểm lại.
- Đã dùng: cutover chạy 13/10/2026 02:06–02:20, production chạy Postgres (main `9552803`). Lời cho phép đã hết hiệu lực: gỡ Mongo và mọi lần merge `main` sau đó cần yêu cầu thẳng mới.
