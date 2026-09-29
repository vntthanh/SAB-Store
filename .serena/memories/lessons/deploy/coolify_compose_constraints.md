# Coolify compose — ràng buộc đã đo

Nguồn: comment đầu `coolify.compose.yml` + commit message của file đó. Đọc file trước khi sửa.

- `${VAR:?message}` KHÔNG được Coolify hỗ trợ: nó thay biến bằng chính chuỗi message thay vì fail
  (đo 2026-09-21: backend crash-loop vì base URL không hợp lệ; DB suýt nhận password là chuỗi lỗi).
  → chỉ dùng `${VAR}` trơn; giá trị nằm trong kho env của Coolify.
- Coolify đổi tên mọi named volume khai trong compose → tách DB/storage/upload khỏi dữ liệu.
  → bind tuyệt đối dưới /srv/appdata/vol/.
- Coolify đăng ký TÊN SERVICE làm network alias; nginx của frontend proxy tới `sabstore-backend:5000`
  → service backend tên `sabstore-backend`. Không `networks:`, không `container_name:`.
- Từ 2026-09-29 backend/frontend **build từ source** (`build:` + `pull_policy: build`). Coolify chạy
  `docker compose build --pull --build-arg <MỌI biến env, kể cả secret>` trong helper container, rồi `up`.
  Build lỗi → deploy fail trước khi thay container (không sập site).
- **Coolify tự CHÈN `ARG <tên>` cho MỌI biến build-time vào MỌI stage của Dockerfile** (log: "Added 56 ARG
  declarations to Dockerfile for service frontend (multi-stage build, added to 2 stages)"), rồi build với
  `--build-arg`. Vì vậy `NODE_ENV=production` có mặt khi `RUN yarn install` → yarn classic bỏ devDependencies →
  `vite: not found` (deploy id 17 ngày 21/09 và id 63 ngày 29/09). Chứng minh 29/09: Dockerfile + `ARG NODE_ENV` +
  `--build-arg NODE_ENV=production` → lỗi; thêm `--production=false` → OK. Build ở máy KHÔNG có dòng ARG nên
  không tái hiện — muốn mô phỏng Coolify phải tự chèn `ARG` sau `FROM`.
  → Mọi lệnh cài dependency trong Dockerfile phải ghi rõ `--production=true|false`, không dựa vào NODE_ENV.
  → Secret cũng bị chèn thành ARG ở mọi stage (ghi vào `docker history`, lộ cho install script lúc build).
  Đã tắt build-time (29/09) cho `JWT_SECRET`, `MONGODB_URI`, `MONGO_INITDB_ROOT_{USERNAME,PASSWORD}`,
  `MINIO_ROOT_{USER,PASSWORD}`, `ADMIN_PASSWORD` — cột `environment_variables.is_buildtime` trong `coolify-db`
  (UI Coolify tự động hoá không ổn định; sửa bằng UPDATE có transaction + kiểm số dòng). Secret mới thêm: tắt
  "Available during build" ngay khi tạo.
- Rollback: git revert về `image: 127.0.0.1:5000/sab-store-{backend,frontend}:migrated-260921` +
  `pull_policy: always` và XOÁ khối `build:` (giữ `build:` cạnh `image:` sẽ build lại dưới tag cũ). Hai tag
  này còn trong registry host (kiểm 2026-09-29: `curl 127.0.0.1:5000/v2/<repo>/tags/list`).
- `cpus: 2` chỉ giới hạn container đang chạy, KHÔNG giới hạn bước build.
- Auto-deploy = GitHub webhook → `webhooks/source/github/events/manual` (log `webhook.deployment.queued` trong
  `/var/www/html/storage/logs/laravel.log` của container `coolify`). Ngày 29/09 GitHub KHÔNG gửi webhook cho một
  lần push (không có dòng log nào) dù lần trước chạy bình thường — nguyên nhân chỉ chủ repo xem được (Recent Deliveries).
  Kích hoạt tay khi UI không dùng được: trên host, lấy secret đã giải mã bằng
  `docker exec coolify php artisan tinker --execute="echo \App\Models\Application::where('uuid','<uuid>')->first()->manual_webhook_secret_github;"`
  (cột trong DB bị mã hoá — ký bằng giá trị thô sẽ ra "Invalid signature"), ký HMAC-SHA256 payload push
  (`ref`, `repository.full_name`, `commits[].modified`) và POST kèm `X-GitHub-Event: push`. Không in secret.
- Sau deploy: kiểm `docker history --no-trunc <image> | grep -c '<SECRET_NAME>='` = 0.
- Đọc log deploy: `ssh -p 24700 david0403@ssh.noboroto.id.vn` rồi
  `docker exec coolify-db psql -U coolify -d coolify -At -c "select logs from application_deployment_queues where id=<id>"`;
  log chứa lệnh build với tên build-arg (giá trị secret nằm ở file, không in ra) — vẫn lọc/redact khi đọc.
- Coolify UI: chỉ đọc qua claude-in-chrome; dòng lịch sử deploy trong UI có thể không bấm mở được → dùng DB.
