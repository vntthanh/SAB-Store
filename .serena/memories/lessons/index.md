# Lessons index — sự thật đã ĐO ĐƯỢC, theo chủ đề

## deploy
- `mem:lessons/deploy/coolify_compose_constraints` — `${VAR:?}` bị thay bằng message; volume bị đổi tên; service name = network alias; build từ source + rollback về tag registry; đọc log deploy từ `coolify-db`.

## database
- `mem:lessons/database/no_mongo_transactions` — prod standalone mongod, harness replica set: transaction xanh ở test, throw ở prod.

## frontend
- `mem:lessons/frontend/monaco_self_hosted` — Monaco tự host (copy `min/vs`, loader.config trong lazy factory); exports map chặn package.json; `/monaco/` no-cache; CSP `worker-src blob:`; Playwright phải gõ bàn phím.

## verification
- `mem:lessons/verification/dev_compose_verify_stack` — dựng stack compose.yml ở :8088: JWT_SECRET mặc định quá ngắn, nginx cần alias `sabstore-backend`, :5000 bị AirPlay chiếm.

## workflow
- `mem:lessons/workflow/agent_tooling_pitfalls` — scout-block hook chặn chuỗi `node_modules`/`build` trong Bash; tin cross-session khác permission mode hết hạn → đọc thẳng repo anh em.

## machine
- `mem:lessons/machine/shared_mac_resources` — Mac dùng chung bị watchdog reset 30/09 (load ~55): không worktree thừa, một agent nặng tại một thời điểm, kiểm owner line khoá.

## process (luật chung của owner — Leaderboard/JudgeHub/QR/SAB)
- `mem:lessons/process/subagent_model_cap` — mọi Agent truyền `model: "sonnet"`; opus chỉ kongming/leo thang (tối đa 1); không fable.
- `mem:lessons/process/heavy_work_lock` — không worktree; một agent nặng cả máy; giao thức `/tmp/cc-heavy.lock` (cờ rỗng = nhường, stale 45', cổng RAM 35%, `CC_HEAVY_OWNER` cho hook).
- `mem:lessons/process/processes_and_quality_gates` — theo dõi/dừng tiến trình mình đẻ; không `--no-verify`; ≥2 reviewer; ≤29 file/commit; không attribution AI.
- `mem:lessons/process/deploy_coordination` — một tên tmux mỗi project, kill rồi tạo lại cùng tên; báo peer trước/sau deploy, không chồng build host.
- `mem:lessons/process/tools_secrets_user_facing` — MCP trước; không in secret; `.gitguardian.yaml` cho fixture; trả lời tiếng Việt.

## sync
- `mem:lessons/sync/syncthing_shared_git` — `.git` đồng bộ Mac↔Windows; git config per-machine; một người ghi git tại một thời điểm.
