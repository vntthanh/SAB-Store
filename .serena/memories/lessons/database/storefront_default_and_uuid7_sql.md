# Gian hàng mặc định + UUIDv7 trong migration SQL

- Gian hàng mặc định có id cố định `01a173f3-7280-71fd-b24f-118da6196e35` (`backend/data/default-storefront.js`); migration `20261025120000_storefronts` chèn đúng id đó, test giữ hai nơi bằng nhau. Hằng số thay vì tra DB: snapshot restore, stand-in Mongo và helper test cần nó không round-trip.
- **Why SQL tự dựng UUIDv7:** PG17 không có `uuidv7()` và `release.sh` chỉ chạy `migrate deploy` (không có bước JS) → migration tạo `pg_temp.uuid_v7()` tạm rồi DROP. **Apply:** backfill id trong migration dùng hàm này, không thêm bước chạy script.
- Harness test: truncate xong tự seed lại gian hàng mặc định; helper factory mặc định `storefrontId` = hằng này.
- Kiểm migration khớp schema: `prisma migrate diff` bằng PG embedded + `--from-config-datasource` cho kết quả rỗng (không drift).
- Mặc định không xoá được (409), cũng như gian hàng còn sản phẩm/combo/đơn hoặc gian hàng active cuối cùng.
