# Deploy: tmux và phối hợp host dùng chung (luật chung JudgeHub/Leaderboard/SAB)

- Mọi tác vụ dài trên server chạy trong `tmux`, đúng MỘT tên session mỗi project (JudgeHub dùng `deploy`).
- Chạy lại: `tmux ls` → `tmux kill-session -t <tên>` → tạo lại cùng tên. Không bao giờ `deploy2`, `deploy-retry`: session chết tích lại, không ai biết cái nào đang chạy thật.
- Trước khi deploy lên host dùng chung với phiên khác: báo trước và sau khi deploy, không chồng build trên host.
- SAB: production deploy do Coolify build khi đẩy `main` (`mem:lessons/deploy/coolify_compose_constraints`); chỉ đẩy `main` khi user yêu cầu thẳng.
- Trước khi build trên host chung: `df -h /` (host còn ~30 GB, 70% dùng — đo 04/10); build từng image một, không hai
  service một lệnh (JudgeHub đo: build song song OOM-kill dbus+systemd).
- Bind-mount một FILE đơn lẻ giữ inode cũ sau `git pull`: `nginx -t`/reload vẫn xanh nhưng chạy config cũ → `--force-recreate`
  (JudgeHub + QR đã đo).
- Backup mongo trước thay đổi hạ tầng: `mongodump --archive --gzip` chạy trong container (creds lấy từ env của container,
  không lộ trên argv host) → `~/backups/sab-store/mongo-<stamp>.archive.gz`, kèm số document mỗi collection.
