# Đặt luật/query ở tầng cao nhất diễn đạt được: Prisma > database > server JS

1. Prisma schema + Client API: unique, default, relation, enum, `@db.VarChar`, cổng `updateMany`, `groupBy`/aggregate, `$transaction`.
2. Database: CHECK, partial index, trigger, `FOR UPDATE`, `$queryRaw` tham số có kiểu.
3. Server JS: chỉ phần hai tầng trên không làm được (gọi dịch vụ ngoài, luật cần state của app).

- Tính trong JS thứ SQL làm được (sum, count, filter) = phát hiện review.
- Constraint DB được phép trùng Zod (lớp fail-closed); Zod trong `@sab/shared` vẫn là cổng request cho message hiển thị.

**Why:** 11/10/2026, trong migration Mongo→Prisma, owner: "Ưu tiên prisma first > database first > server side".
