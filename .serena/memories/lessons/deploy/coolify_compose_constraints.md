# Coolify compose — ràng buộc đã đo

Nguồn: comment đầu `coolify.compose.yml` + commit message của file đó. Đọc file trước khi sửa.

- `${VAR:?message}` KHÔNG được Coolify hỗ trợ: nó thay biến bằng chính chuỗi message thay vì fail
  (đo 2026-09-21: backend crash-loop vì base URL không hợp lệ; DB suýt nhận password là chuỗi lỗi).
  → chỉ dùng `${VAR}` trơn; giá trị nằm trong kho env của Coolify.
- Coolify đổi tên mọi named volume khai trong compose → tách DB/MinIO/upload khỏi dữ liệu.
  → bind tuyệt đối dưới /srv/appdata/vol/.
- Coolify đăng ký TÊN SERVICE làm network alias; nginx của frontend proxy tới `sabstore-backend:5000`
  → service backend tên `sabstore-backend`. Không `networks:`, không `container_name:`.
- Từ 2026-09-29 backend/frontend **build từ source** (`build:` + `pull_policy: build`). Coolify chạy
  `docker compose build --pull --build-arg <MỌI biến env, kể cả secret>` trong helper container, rồi `up`.
  Build lỗi → deploy fail trước khi thay container (không sập site).
- Lỗi build `vite: not found` ngày 2026-09-21 (deploy id 17 trong `coolify-db`, bảng
  `application_deployment_queues`): `yarn install` đã cài devDependencies, `yarn build` vẫn không thấy vite.
  KHÔNG tái hiện được (2026-09-29): build amd64 ở máy, có/không `--build-arg NODE_ENV=production`, đều OK;
  context Coolify chỉ gồm file git track. Nguyên nhân chưa rõ — nếu tái diễn, đọc log ở bảng trên trước khi sửa.
- Rollback: git revert về `image: 127.0.0.1:5000/sab-store-{backend,frontend}:migrated-260921` +
  `pull_policy: always` và XOÁ khối `build:` (giữ `build:` cạnh `image:` sẽ build lại dưới tag cũ). Hai tag
  này còn trong registry host (kiểm 2026-09-29: `curl 127.0.0.1:5000/v2/<repo>/tags/list`).
- `cpus: 2` chỉ giới hạn container đang chạy, KHÔNG giới hạn bước build.
- Đọc log deploy: `ssh -p 24700 david0403@ssh.noboroto.id.vn` rồi
  `docker exec coolify-db psql -U coolify -d coolify -At -c "select logs from application_deployment_queues where id=<id>"`;
  log chứa lệnh build với tên build-arg (giá trị secret nằm ở file, không in ra) — vẫn lọc/redact khi đọc.
- Coolify UI: chỉ đọc qua claude-in-chrome; dòng lịch sử deploy trong UI có thể không bấm mở được → dùng DB.
