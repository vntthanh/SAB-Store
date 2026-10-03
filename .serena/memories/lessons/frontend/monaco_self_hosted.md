# Monaco tự host trong frontend Vite (port từ JudgeHub)

- `@monaco-editor/react` mặc định tải từ cdn.jsdelivr.net → nằm ngoài CSP `script-src 'self'`. Tự host: `frontend/scripts/copy-monaco.mjs` copy `monaco-editor/min/vs` vào `public/monaco/vs` (gitignore + dockerignore), chạy tường minh trong script `dev`/`build`; `loader.config({ paths: { vs: MONACO_VS_PATH } })` đặt TRONG factory của `React.lazy` để wrapper không vào bundle chính.
- `require.resolve('monaco-editor/package.json')` lỗi: `exports` map không lộ package.json → resolve entry chính rồi đi ngược lên tìm package.json có `name` khớp.
- 0.56: `loader.js`/`editor/editor.main.js` giữ tên qua các version, chunk thì có hash → `/monaco/` phải `Cache-Control: no-cache` (location `^~` trong `frontend/nginx.conf`), không được ăn khối static `immutable 1y`.
- 0.56 khởi tạo worker từ URL `blob:` → CSP cần `worker-src 'self' blob:`.
- Kiểm bằng Playwright: `fill()` vào textarea của Monaco 0.56 hỏng ("element is not editable") → click editor rồi `page.keyboard.type(...)` qua `browser_run_code_unsafe`.

**Why:** đo khi làm editor lời nhắc Markdown trong trang admin Settings, 03/10/2026.
**How to apply:** mọi editor Monaco mới đi qua `frontend/src/components/admin/MarkdownEditor.js`; đổi đường dẫn chỉ sửa `frontend/src/lib/monaco-assets.js` (script copy import chính hằng đó).
