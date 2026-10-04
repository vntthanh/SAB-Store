# Máy Mac dùng chung nhiều phiên Claude — giới hạn tài nguyên (đã đo)

Sự cố đo được: 30/09/2026 22:59 máy bị watchdog reset (ResetCounter "Boot faults: wdog"), load ~55.
Chồng chéo lúc đó: một commit JudgeHub chạy full suite qua hook (trong khoá) + 3 agent implement của
Leaderboard (2 cái trong git worktree riêng, mỗi cái MCP/Playwright riêng) + ~8 trình duyệt Playwright
ngoài khoá + ~19 container. `/tmp` bị xoá khi reboot → mọi log khoá mất.

Luật do user đặt (chuyển qua phiên Leaderboard: "không được phép nhiều working tree khi không cần thiết"):
- KHÔNG tạo thêm git worktree (`git worktree add`, Agent `isolation: "worktree"`) trừ khi thật cần VÀ user đồng ý.
  Worktree tránh xung đột file nhưng nhân đôi CPU/RAM (deps, typecheck, test runner, browser).
- Cả máy: tối đa MỘT agent vừa sửa code vừa test/install/build/lái trình duyệt tại một thời điểm.
  Agent chỉ sửa file (lint được) có thể song song; reviewer read-only không browser song song số ít.
- `/tmp/cc-heavy.lock` chỉ xếp hàng việc NÀO CHỊU lấy khoá; không kiểm tra tài nguyên còn trống.
- Lời subagent "đã giữ khoá" phải kiểm được: orchestrator grep đúng owner line trong
  `/tmp/cc-heavy.lock/owner` trước khi tin (29/09 ~23:20 một verify-agent SAB báo giữ khoá lúc owner là phiên khác).

Cổng `memory_pressure -Q` < 35%, định nghĩa "heavy", dừng stack nhàn rỗi: đã thành luật của owner
(chuyển qua Leaderboard 03/10/2026) — giao thức đầy đủ ở `mem:lessons/process/heavy_work_lock`.

## Lần reset thứ hai — 04/10/2026 18:22:54 (đã đo)
- Panic `watchdog timeout: no checkins from watchdogd in 91 seconds`; panic report
  (`/Library/Logs/DiagnosticReports/Retired/panic-full-*.panic`, JSON `processByPid`) cho thấy 3 tiến trình `node`
  RSS 9.5 / 7.2 / 2.3 GB trên máy 16 GB, `free` pages ≈ 900. Phiên Leaderboard nhận: pre-commit hook của họ chạy hai
  lần liền không qua cổng memory. Panic report KHÔNG có argv/ppid → chỉ quy trách nhiệm được qua hỏi các phiên.
- eslint trong hook (đo ở Leaderboard): 4 luồng đỉnh 13.6 GB, 1 luồng 4.4 GB, thời gian gần như nhau → chạy 1 luồng.
- Agent verify trình duyệt có dựng dev stack cục bộ = việc nặng: giữ khoá, chạy một mình (JudgeHub 04/10).
- Reboot xoá `/private/tmp` → scratchpad của phiên (script, log, nguồn artifact) mất. Đọc lại artifact bằng
  `Artifact action=read`; thứ phải giữ qua reboot thì để trong `plans/` hoặc repo.
