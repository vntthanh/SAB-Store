# Việc nặng, worktree và khoá máy `/tmp/cc-heavy.lock` (luật của owner, chung mọi repo trên Mac)

Bối cảnh sự cố (máy crash 30/09/2026): `mem:lessons/machine/shared_mac_resources`.

## Một agent nặng, không worktree
- KHÔNG `isolation: "worktree"`, KHÔNG `git worktree add`.
- "Nặng" = test, install, typecheck, build, dựng app/compose stack, lái trình duyệt. Cả máy chỉ MỘT agent làm việc nặng tại một thời điểm, và phải giữ khoá.
- Agent chỉ sửa file chạy song song được nếu sở hữu file tách rời; được lint, KHÔNG test/typecheck. Một verify agent chạy test sau cùng.

## Giao thức khoá (không repo nào miễn)
- Khi chờ: giữ cờ `/tmp/cc-heavy.<repo>-wants` chứa `<Repo> <job> <epoch>`; `touch` mỗi nhịp poll (heartbeat).
- Cờ mtime > 5 phút là chết. KHÔNG BAO GIỜ xoá cờ/khoá của phiên khác.
- Epoch cũ nhất đi trước. Cờ còn sống nhưng rỗng/không đọc được = coi như cũ hơn mình → nhường.
- Lấy khoá: `mkdir /tmp/cc-heavy.lock`, rồi `echo "$OWNER" > /tmp/cc-heavy.lock/owner` (owner line chính xác).
- Trước MỖI bước nặng: `grep -qxF "$OWNER" /tmp/cc-heavy.lock/owner`.
- Nhả chỉ bằng: `grep -qxF "$OWNER" /tmp/cc-heavy.lock/owner && rm -rf /tmp/cc-heavy.lock`.
- Khoá chỉ coi là stale sau 45 phút VÀ sau khi đã nhắn chủ của nó.
- Cổng RAM: `memory_pressure -Q` trước mỗi bước nặng; free < 35% → CHỜ.
- Dev server / compose stack sống lâu tính vào ngân sách → dừng khi việc tạm ngưng.
- Ưu tiên giữa repo chỉ khi user cấp, có giờ kết thúc (thông báo qua phiên được cấp).
- Git hook tự lấy khoá: shell đang giữ khoá phải `export CC_HEAVY_OWNER='<owner line chính xác>'` trong CÙNG lệnh với `git commit`/`git push`, nếu không hook chờ mãi chính khoá của mình.

## Khoá trong git hook (SAB dùng husky từ 03/10/2026, cùng mẫu JudgeHub/Leaderboard)
- Hook pre-commit/pre-push tự lấy khoá qua `.husky/lib/heavy-lock.sh` (bản chép nguyên văn từ Leaderboard); commit/push chỉ `.md` bỏ qua khoá.
- Ctrl-C/TERM/HUP nhả khoá chỉ khi owner line vẫn là của mình. Sau SIGKILL khoá kẹt lại: kiểm owner line trước khi xoá tay.
- Hook cũng chờ bộ nhớ trống ≥ 35% (macOS/Linux) hoặc ≥ 21% (Windows; ghi đè bằng `CC_HEAVY_MIN_FREE_PCT`) → commit có thể đứng lâu; đọc dòng "heavy-lock: waiting".
- Có hook chạy test thì KHÔNG chạy test/lint "kiểm tra lần cuối" ngay trước commit — gấp đôi thời gian cho cùng kết quả. Chi tiết hook của SAB: AGENTS.md §4.
- Từ 04/10 (commit 07c8326): `heavy-lock.sh` + `hook-env.sh` là bản chuẩn của Leaderboard (8e52781), chép nguyên văn —
  cổng memory cả Windows (`powershell.exe`) và Linux (`/proc/meminfo`), chờ tối đa 1800 s rồi lỗi (không bao giờ chạy
  ngoài khoá), `CC_HEAVY_TMP` là alias của `CC_HEAVY_ROOT`. Bản chung chỉ sửa ở Leaderboard rồi mọi repo chép lại;
  so bằng `shasum -a 256` với commit đã chốt, không so working tree của repo khác (có thể đang dở).
- Commit từ GitHub Desktop/IDE chạy hook với PATH launchd trơn (`/usr/bin:/bin:/usr/sbin:/sbin`): không có node keg-only
  của Homebrew, không có shim của corepack (shim chỉ nằm cạnh binary node). `hook-env.sh` + phần riêng của repo bổ sung PATH.
- Đang giữ khoá thì chờ ở foreground có timeout; đừng treo lệnh chờ nền — agent đứng yên vẫn giữ khoá (bài học QR).

**How to apply:** snippet chuẩn nằm ở AGENTS.md §4 ("Khoá máy dùng chung"); sửa snippet thì giữ khớp memory này.
