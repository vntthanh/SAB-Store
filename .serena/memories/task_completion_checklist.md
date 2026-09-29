# Task Completion Checklist — SAB-Store

Luật đầy đủ ở `AGENTS.md`; đây chỉ là checklist.

1. Đang ở nhánh `dev` (không commit thẳng `main`).
2. Chạy test hẹp cho phần đã đụng (`cd backend && yarn test <pattern>`); `yarn build` nếu đụng frontend. Repo chưa có git hook — không có cổng tự động.
3. Soi comment trong diff: xoá work log, tham chiếu plan/phase, path không track.
4. ≥2 agent review read-only với góc nhìn khác nhau (hồi quy / zero-trust / toàn vẹn dữ liệu / test).
5. Stage file tường minh; không kéo theo thay đổi chưa commit của user.
6. Conventional Commit, mô tả hành vi/invariant.
7. Bài học mới đã đo → `write_memory` vào `lessons/<topic>/…` + dòng trong `lessons/index`.
8. Dọn tiến trình jest/vitest/dev server mình đã khởi động.
