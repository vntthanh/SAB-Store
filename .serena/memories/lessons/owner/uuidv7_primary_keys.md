# Primary key là UUIDv7 native

- Mọi PK: `String @id @default(uuid(7)) @db.Uuid` (thay kế hoạch cũ giữ ObjectId 24-hex dạng TEXT).
- ObjectId cũ đổi bằng `objectIdToUuidV7()` thuần, đơn ánh: timestamp ms = giây ObjectId × 1000, 64 bit còn lại lấp phần random. Cùng hàm dịch idempotency key, job id, id nhúng trong JSON, file backup cũ, giỏ hàng trên trình duyệt, id better-auth.
- better-auth sinh id qua `advanced.database.generateId`.
- Validator nhận UUID, và trong giai đoạn chuyển tiếp nhận id 24-hex cũ rồi map.
- Insert raw SQL lấy id từ `v7()` của package `uuid` — PG17 không có `uuidv7()`.

**Why:** 11/10/2026 owner: "Các primary key hãy dùng uuidv7".
