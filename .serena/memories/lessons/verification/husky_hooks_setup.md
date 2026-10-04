# Husky ở SAB-Store (dựng 03/10/2026)

- SAB không có workspace gốc → thêm `package.json` gốc tối thiểu (private, chỉ husky, `prepare: husky`) + `pnpm-lock.yaml` gốc (yarn tới 04/10/2026). Docker build dùng context `backend/`/`frontend/` nên không bị ảnh hưởng.
- `.husky/_/` do husky sinh, tự gitignore. `core.hooksPath` là git config RIÊNG từng máy (Syncthing không đồng bộ) → mỗi máy chạy `pnpm install` ở gốc một lần.
- Husky gọi hook bằng `sh -e` (bỏ qua shebang); `/bin/sh` macOS là bash 3.2 → `.husky/lib/require-bash.sh` re-exec sang bash ≥4 (Homebrew). Kiểm bằng `PATH=/usr/bin:/bin sh -e .husky/<hook> ...`.
- `pre-push` đọc danh sách ref từ stdin một lần; `heavy_lock_hook` chạy lại script dưới khoá → truyền ref qua env `CC_SAB_PUSH_REFS`.
- `jest --findRelatedTests routes/settings.js` (cwd backend) kéo ~28 suite vì app import gần hết route — related ≈ gần full suite với file route/app.
- Flake đã thấy 1 lần: `tests/pricing/orders-route.test.js` hỏng khi chạy cùng 28 suite, không tái hiện (riêng 3/3 xanh, full 2/2 xanh 190/190). Thấy lại thì chụp tên test + message trước khi rerun.
  - 04/10 23:52 (hook full suite, 49 suite): `order-stock-ledger` timeout 30 s ở `beforeEach` → `makeAdminSession` (sign-up Better Auth), không phải assertion; chạy lại ngay xanh 394/394, RAM trống 60%. Hai lần đều là suite route nặng chạy song song → nghi đói CPU khi sign-up (hash mật khẩu); lặp lại lần ba thì cân nhắc tạo phiên admin một lần mỗi file thay vì mỗi test.
  - 05/10 02:51 (pre-push, 51 suite): `admin-edit-order-items` › seller 403/ẩn danh 401 → `read ECONNRESET` (supertest `request(app)` tạo server tạm mỗi request), không phải assertion. Lần thứ 3 có flake khi full suite song song → nếu gặp lần nữa: dùng một server `app.listen()` chung mỗi file hoặc `--maxWorkers` thấp hơn trong hook.
  - 05/10 06:16: lại `ECONNRESET` (client-ip › skips health checks, GET không body); chạy lại xanh 432/432. **Đã bác giả thuyết keep-alive**: superagent 8 đặt `agent: false` cho mỗi request (đọc `lib/node/index.js`), nên đổi `http.globalAgent` vô tác dụng. Nguyên nhân chưa rõ (nghi tải CPU khi nhiều worker + mongodb-memory-server). Bước đo tiếp: lặp 2 file đó dưới tải, so `--maxWorkers=2` với mặc định, log `err.syscall`.

**How to apply:** hook hỏng vì "bash >= 4" → `brew install bash`; hook đứng lâu → đọc dòng "heavy-lock: waiting".
