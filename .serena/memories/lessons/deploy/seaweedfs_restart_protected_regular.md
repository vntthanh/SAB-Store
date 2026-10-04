# SeaweedFS crash-loop sau restart container (sự cố 04/10/2026)

- Host `david-host` đặt `fs.protected_regular=2`: trong thư mục sticky (`/tmp`) ngay cả root cũng không `O_CREAT` đè được file của user khác.
- Script khởi động cũ ghi `/tmp/s3.json` rồi `chown seaweed`. `docker restart` (không recreate) giữ lại file đó → lần chạy sau "can't create /tmp/s3.json: Permission denied" → `sabstore-seaweedfs` restart lặp → `sabstore-backend` chết → `store.sabies.vn/api` 502 (~02:35–11:05 ngày 04/10).
- Kích hoạt: unattended-upgrades nâng docker (29.4.3→29.8.2) làm dockerd restart mọi container.
- Khôi phục tay: force-recreate seaweed rồi backend trên server. Sửa gốc: commit `a1b468b` — config ghi vào `/etc/seaweedfs` (không sticky) và `rm -f` trước khi ghi, ở cả 3 file compose. JudgeHub từng gặp cùng lỗi (commit 64f6ab3a của repo JudgeHub).

**How to apply:** script khởi động container ghi file rồi đổi owner thì không đặt trong `/tmp`, và xoá file cũ trước khi ghi — container có thể bị restart chứ không chỉ recreate. Kiểm bằng `docker restart <container>` sau lần chạy đầu, không chỉ `up`.
