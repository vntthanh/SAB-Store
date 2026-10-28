# Better Auth 1.7.7: email-otp + One Tap — các điều đã đo

Nguồn: `backend/lib/auth.js`, `backend/lib/auth-guards.js`, `backend/tests/auth/*` (đo khi thêm đăng nhập bằng mã email + Google One Tap).

## email-otp
- Plugin có 9 endpoint. `disabledPaths` được kiểm TRƯỚC rate limiter và trả 404 → tắt endpoint thừa bằng `disabledPaths`, không cần rule limiter cho nó.
- Đăng nhập bằng mã trên tài khoản CHƯA verify email: Better Auth xoá accounts + sessions của user (`revokeUnprovenAccountAccess`) và trên Postgres trả 500 (verification id không phải uuid). **Why:** mã chứng minh chủ hộp thư → hệ thống coi mật khẩu cũ là của kẻ chiếm trước; với staff = mất mật khẩu. **Apply:** before-hook từ chối staff chưa verify (và customer chưa verify) TRƯỚC khi tới handler; staff chạy `scripts/verify-staff-emails.js` mới dùng được mã/Google.
- Lỗi ném trong `sendVerificationOTP` bị nuốt (endpoint vẫn trả success) → kiểm SMTP bật/cooldown/cap ở before-hook để khách thấy lỗi thật. **Why enumeration decoys:** địa chỉ lạ/staff vẫn trả success giả, không lộ email nào tồn tại.
- `parseUserInput` nhận field từ body client (ví dụ `username`) → hook phải strip trước khi tạo user.
- Field của schema plugin ghi đè `user.additionalFields` cùng tên.
- `databaseHooks` chạy SAU cùng; với admin tạo user thì `ctx.path === '/admin/create-user'`.

## One Tap / account linking
- `accountLinking`: provider trusted bỏ qua kiểm `email_verified` của Google → phải guard (không link vào user staff chưa verify).
- `requireLocalEmailVerified` mặc định true: chặn link vào user local chưa verify (đúng ý, đừng tắt).
- Seam test One Tap = `globalThis.fetch` tới Google certs (không có tuỳ chọn inject).
- Triệu chứng đo 26/10 trên production: Google đăng nhập khách mới OK (200) nhưng email của tài khoản staff chưa verify → `/one-tap/callback` 401 (Better Auth từ chối link, không log gì ở backend ngoài access log). Chẩn đoán: query `"user"."emailVerified"` + `account."providerId"` theo email; chữa: `scripts/verify-staff-emails.js --apply`. Lỗi console COOP/postMessage và CSP report-only `injectScript.js` (extension như 1Password) là nhiễu, không phải nguyên nhân.
- Callback `/one-tap/callback` đọc `options.clientId` của plugin **mỗi request** (`audience = options?.clientId || socialProviders.google.clientId`, đọc source `plugins/one-tap/index.mjs`) → client id đổi lúc chạy được bằng cách sửa object options đã truyền vào `oneTap()`; SAB-Store làm vậy trong guard (`oneTapOptions`), client id lưu ở bảng settings. Đừng đưa Google vào `socialProviders` để lấy audience: bật luôn luồng redirect cần secret.

## Rate limit
- Mặc định chỉ bật ở production; `customRules` ghi đè từng path; store là memory theo process (nhiều process = đếm riêng) → cap theo email/giờ lưu trong bảng `verification`.

## Admin plugin
- `/admin/update-user` kiểm username unique theo người GỌI, không phải target → đổi username target có thể đụng/né → có test `admin-update-user`.
- Guard chạy trước kiểm session/permission của plugin → guard phải kiểm session TRƯỚC, nếu không rò thông tin cho người chưa đăng nhập.
