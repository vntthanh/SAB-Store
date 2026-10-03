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
