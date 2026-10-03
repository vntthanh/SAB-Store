# Tiến trình nền và cổng chất lượng (luật của owner, chung Leaderboard/JudgeHub/QR/SAB)

## Tiến trình
- Ghi lại mọi tiến trình nền mình khởi động: lệnh, PID, cổng.
- Trước khi khởi động: dùng lại hoặc dừng chủ cũ; không bao giờ đẻ bản trùng trên cổng mới.
- Dừng thứ mình khởi động khi việc xong. Không giết tiến trình của phiên khác; không bao giờ giết `tsserver.js`.
- Why: 03/10/2026 Leaderboard thấy 2 tiến trình `nest start --watch` mồ côi (4h, 8h) phục vụ code cũ.

## Cổng chất lượng
- Không bao giờ `git commit --no-verify` / `git push --no-verify`. Hook là cổng chất lượng; không có GitHub CI.
- Trước mỗi commit có code: ≥2 agent review read-only, mỗi agent một góc: hồi quy · rò dữ liệu/zero-trust · toàn vẹn dữ liệu · biên tập + chất lượng test. Mỗi phát hiện có `file:line` + kịch bản hỏng có thật, tới được. Sửa phát hiện FIX-FIRST trước khi commit.
- Conventional Commits, KHÔNG dòng attribution AI. ≤ 29 file mỗi commit; commit từng wave đã verify ngay.
- Comment giải thích VÌ SAO. Không work log, không nhãn plan/phase/audit, không tham chiếu path không track (`plans/`, `ref/`, `/Users/...`).
