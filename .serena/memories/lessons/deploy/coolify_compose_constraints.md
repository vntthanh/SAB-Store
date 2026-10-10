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
  Push `main` lúc 23:43 ngày 29/09 (commit 02798d6) → deployment tạo trong < 10 s: webhook hoạt động lại.
- `command:` nhiều dòng dạng list một phần tử `- |` với `$$` được Coolify giữ đúng (đo 29/09 trên SeaweedFS:
  `docker inspect` Cmd còn `$S3_…`, không `$$`). `docker compose config` in lại `$$` → khi trích command để chạy
  thử phải đổi `$$`→`$`.
- Sửa env của app (id 12) không qua UI: `php artisan tinker` với `\App\Models\EnvironmentVariable`
  (`resourceable_type='App\Models\Application'`, `resourceable_id=12`, `is_preview=false`); `value` tự
  giải mã/mã hoá qua Eloquent — không UPDATE thẳng SQL cột `value`. Chỉ in path/độ dài, không in giá trị.
  Tinker echo lại dòng lệnh với tiền tố `> `: lọc output theo marker riêng, đừng `grep '^R'`.
- Thêm biến MỚI (đo 04/10, `MONGO_REPLICA_KEY`): `new \App\Models\EnvironmentVariable()` với `key`, `value`
  (lấy từ `getenv()` — truyền bằng `docker exec -e KEY` không kèm giá trị, để secret không nằm trong argv),
  `is_buildtime=false`, `is_preview=false`, `resourceable_type='App\Models\Application'`, `resourceable_id=12`, `save()`.
  Đếm trước (idempotent), in lại chỉ độ dài + `is_buildtime`.
- Chọn container của app trên host (nhiều project): label `com.docker.compose.project=xy4efknzf2uepknbnsktconc`
  + `com.docker.compose.service=<service>`. Đổi tên service → Coolify tự xoá container service cũ (đo 29/09:
  `minio` biến mất khi thay bằng `sabstore-seaweedfs`), bind cũ còn nguyên.
- Sau deploy: kiểm `docker history --no-trunc <image> | grep -c '<SECRET_NAME>='` = 0.
- Đọc log deploy: `ssh -p 24700 david0403@ssh.noboroto.id.vn` rồi
  `docker exec coolify-db psql -U coolify -d coolify -At -c "select logs from application_deployment_queues where id=<id>"`;
  log chứa lệnh build với tên build-arg (giá trị secret nằm ở file, không in ra) — vẫn lọc/redact khi đọc.
- Coolify UI: chỉ đọc qua claude-in-chrome; dòng lịch sử deploy trong UI có thể không bấm mở được → dùng DB.

- Chuỗi proxy production (đo 04/10): host :80/:443 → Traefik v3.6 `coolify-proxy` (mạng project `10.0.10.0/24`, Traefik `.5`) →
  nginx frontend (`.6`) → backend. `$remote_addr` của nginx = IP Traefik cho MỌI request; IP khách ở X-Forwarded-For (trường
  cuối của log). Traefik GHI ĐÈ XFF client gửi (probe `X-Forwarded-For: 9.9.9.9` → nginx chỉ thấy IP thật) — khác
  proxy-manager của JudgeHub (nối thêm). Đếm khách: dùng trường XFF, không dùng trường đầu (thấy "1 IP" là sai).
- Cổng deploy của user (04/10): downtime < 30 s → deploy ngay (đo bằng probe 1 req/s suốt lần deploy); không bảo đảm
  được thì chỉ deploy khi 15 phút không ai xem sản phẩm — script đọc log `activity-check.sh` (thư mục plan kênh bán).
  Trước deploy: verify bằng Playwright MCP trên localhost với catalog clone từ production (products/combos/settings, không dữ liệu khách).
- **Downtime một lần deploy Coolify ≈ 100 s** (đo 04/10 20:44:06→20:45:47, deploy 78, probe 1 req/s: 84 mẫu 502/503):
  Coolify xoá CẢ stack compose (kể cả mongo, seaweedfs không đổi cấu hình) rồi mới `up`. Phân rã đo được: ~30 s nginx
  dừng (SIGQUIT chờ keep-alive), ~21 s mongod dừng, ~27 s build ảnh lần hai ở `up` (`pull_policy: build`), ~16 s
  SeaweedFS khởi động (backend chờ `service_healthy`), ~5 s probe health đầu.
  Đã chỉnh trong `coolify.compose.yml` (comment đầu file): `pull_policy: never`, nginx `stop_signal: SIGTERM`, mongod
  `shutdownTimeoutMillisForSignaledShutdown`, `start_interval`, backend chờ deps `service_started`. **Chưa đo lại** →
  tới khi probe 1 req/s chứng minh < 30 s, vẫn chỉ deploy trong cửa sổ "15 phút không ai xem sản phẩm" (`activity-check.sh`).
  `pull_policy: never` + `build:` vẫn build khi ảnh vắng (compose `build.go`: chỉ bỏ build khi ảnh có sẵn).
- **Đo lại sau khi chỉnh (deploy 80, 05/10 01:54, probe 1 req/s):** trang tĩnh sập **57 s** (503 01:54:34 → 200 01:55:31),
  API sập **89 s** (502 tới 01:56:03). Phần thêm 32 s của API: backend chờ SeaweedFS (`ECONNREFUSED :9000`, `start.js`
  thử lại 2 s/lần) vì mọi container tạo cùng lúc. Vẫn > 30 s → giữ luật cửa sổ yên tĩnh / khung giờ user cho phép.
  Đã làm 05/10: `start.js` mở cổng sau MongoDB, tạo bucket ngầm (ảnh do nginx đọc thẳng SeaweedFS).
  **Đo lại deploy 84 (05/10 11:19, probe 1 req/s): trang 61 s, API 64 s** (trước 57/89) → API không còn chờ SeaweedFS;
  phần còn lại là Coolify xoá + tạo lại cả stack. Vẫn > 30 s.
  Hướng tiếp (user chọn để sau): tách mongo/redis/seaweedfs sang resource Coolify riêng để deploy code không restart dữ liệu
  (JudgeHub deploy bằng `compose up -d` nên chỉ tạo lại service đổi ảnh/cấu hình).
  **Deploy 94 (10/10 14:28, đổi ảnh node 24 + redis 8, probe 1 req/s): trang 58 s, API 62 s** — ổn định quanh 60 s.
