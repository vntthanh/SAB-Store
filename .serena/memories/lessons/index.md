# Lessons index — sự thật đã ĐO ĐƯỢC, theo chủ đề

## deploy
- `mem:lessons/deploy/coolify_compose_constraints` — deploy Coolify sập ~100 s (recreate cả stack, đo 04/10) → chỉ deploy trong cửa sổ yên tĩnh; `${VAR:?}` bị thay bằng message; volume bị đổi tên; service name = network alias; build từ source + rollback về tag registry; đọc log deploy từ `coolify-db`.
- `mem:lessons/deploy/seaweedfs_restart_protected_regular` — `fs.protected_regular=2` + file trong `/tmp` sticky → seaweed crash-loop sau `docker restart` (502 ngày 04/10); config ở `/etc/seaweedfs`, xoá trước khi ghi.

## database
- `mem:lessons/database/no_mongo_transactions` — prod lên replica set `rs0` 04/10 (đã đo, keyfile /etc/mongo chmod 755, key không xuống dòng); backend fail-fast; rollback phải revert cả kiểm replica set.

## frontend
- `mem:lessons/frontend/monaco_self_hosted` — Monaco tự host (copy `min/vs`, loader.config trong lazy factory); exports map chặn package.json; `/monaco/` no-cache; CSP `worker-src blob:`; Playwright phải gõ bàn phím.

## verification
- `mem:lessons/verification/dev_compose_verify_stack` — dựng stack compose.yml ở :8088: JWT_SECRET mặc định quá ngắn, nginx cần alias `sabstore-backend`, :5000 bị AirPlay chiếm.
- `mem:lessons/verification/husky_hooks_setup` — husky + hook theo loại file (gốc workspace/shared/frontend); hooksPath riêng từng máy; re-exec bash ≥4; ref pre-push qua env; flake orders-route chưa tái hiện.

## workspace
- `mem:lessons/workspace/workspace_docker_images` — đọc trước khi sửa Dockerfile, dockerignore hoặc dependency: root context, ignore per-Dockerfile, `pnpm deploy` không `--legacy`.
- `mem:lessons/workspace/shared_package_build` — đọc khi sửa `packages/shared` hoặc thấy test xanh mà hành vi cũ: build cũ = xanh giả, `jitless`, không import `zod` trực tiếp.
- `mem:lessons/workspace/validation_golden_fixtures` — đọc trước khi đổi validation của route: fixture vàng, khối `intentional`, replay qua một server.
- `mem:lessons/workspace/dependency_upgrade_limits` — đọc trước khi nâng package/ảnh: better-auth >1.3.8 vỡ Jest 29 (ESM-only), ảnh dùng chung trên david-host, Redis 8 một chiều + RAM, đường lên mongo.

## workflow
- `mem:lessons/workflow/agent_tooling_pitfalls` — scout-block hook chặn chuỗi `node_modules`/`build` trong Bash; tin cross-session khác permission mode hết hạn → đọc thẳng repo anh em.

## machine
- `mem:lessons/machine/shared_mac_resources` — watchdog reset 30/09 và 04/10 18:22 (3 node 19 GB RSS, hook chạy đôi): không worktree thừa, một agent nặng, eslint 1 luồng, verify trình duyệt có stack = nặng; reboot xoá scratchpad.

## process (luật chung của owner — Leaderboard/JudgeHub/QR/SAB)
- `mem:lessons/process/subagent_model_cap` — mọi Agent truyền `model: "sonnet"`; opus chỉ kongming/leo thang (tối đa 1); không fable.
- `mem:lessons/process/heavy_work_lock` — không worktree; một agent nặng cả máy; giao thức `/tmp/cc-heavy.lock` (cờ rỗng = nhường, stale 45', cổng RAM 35% (Windows 21%), `CC_HEAVY_OWNER` cho hook); bản chung heavy-lock/hook-env của Leaderboard (chờ ≤1800 s, cổng RAM Windows/Linux, PATH cho GitHub Desktop).
- `mem:lessons/process/processes_and_quality_gates` — theo dõi/dừng tiến trình mình đẻ; không `--no-verify`; ≥2 reviewer; ≤29 file/commit; không attribution AI.
- `mem:lessons/process/deploy_coordination` — một tên tmux mỗi project; báo peer trước/sau deploy; `df -h` + build từng image; bind-mount file đơn giữ inode cũ; backup mongo bằng mongodump trong container.
- `mem:lessons/process/tools_secrets_user_facing` — MCP trước; không in secret; `.gitguardian.yaml` cho fixture; trả lời tiếng Việt.

## sync
- `mem:lessons/sync/syncthing_shared_git` — `.git` đồng bộ Mac↔Windows; git config per-machine; một người ghi git tại một thời điểm.
