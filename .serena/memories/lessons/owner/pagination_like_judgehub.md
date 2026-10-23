# Phân trang theo JudgeHub

- Query: `PaginationQuerySchema` (page ≥ 1, mặc định 1; limit 1..100, mặc định 20) và `buildPaginationMeta` trong `@sab/shared`.
- Envelope: `{ data, meta: { page, limit, total, totalPages } }`.
- Repository: `toSkipTake`, chạy `count` + `findMany` song song; sort luôn kết thúc bằng id làm tie-breaker.
- Không dùng `mongoose-paginate-v2`.
- Nguồn tham chiếu (chỉ đọc): repo JudgeHub, `packages/shared/src/zod/pagination.ts` và `packages/shared/src/helpers/prisma.ts`. Tổng quát: SAB cần pattern mà JudgeHub đã có → đọc JudgeHub trước rồi làm theo.

**Why:** 11/10/2026 owner: "Học cách phân trang từ Judgehub".
