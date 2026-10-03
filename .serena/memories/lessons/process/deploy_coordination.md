# Deploy: tmux và phối hợp host dùng chung (luật chung JudgeHub/Leaderboard/SAB)

- Mọi tác vụ dài trên server chạy trong `tmux`, đúng MỘT tên session mỗi project (JudgeHub dùng `deploy`).
- Chạy lại: `tmux ls` → `tmux kill-session -t <tên>` → tạo lại cùng tên. Không bao giờ `deploy2`, `deploy-retry`: session chết tích lại, không ai biết cái nào đang chạy thật.
- Trước khi deploy lên host dùng chung với phiên khác: báo trước và sau khi deploy, không chồng build trên host.
- SAB: production deploy do Coolify build khi đẩy `main` (`mem:lessons/deploy/coolify_compose_constraints`); chỉ đẩy `main` khi user yêu cầu thẳng.
