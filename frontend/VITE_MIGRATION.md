# Migration từ Create React App sang Vite

> **Lỗi thời một phần (14/09/2026).** `VITE_API_URL` đã bị **xóa hẳn**, không còn
> là build arg hay biến môi trường. Frontend gọi API bằng path tương đối `/api`,
> nên không cần biến nào chứa domain — xem AD-3 trong plan
> `260914-1430-harden-prod-single-route-and-critical-fixes`. Mọi đoạn nhắc tới
> `VITE_API_URL` bên dưới chỉ còn giá trị lịch sử.

## Tóm tắt thay đổi

Frontend đã được chuyển từ **Create React App (react-scripts)** sang **Vite** để:
- Build nhanh hơn (~10-100x)
- Hot Module Replacement (HMR) tức thời
- Bundle size nhỏ hơn
- Dev server khởi động nhanh hơn

## Files đã thay đổi

### 1. Package Configuration
- **`package.json`**: Thay `react-scripts` bằng `vite` và `@vitejs/plugin-react`
- **`vite.config.js`**: Config mới cho Vite (thay thế CRA config)

### 2. HTML Entry Point
- **`index.html`**: Di chuyển từ `public/index.html` ra root directory
  - Thay `%PUBLIC_URL%` bằng `/` (relative paths)
  - Thêm `<script type="module" src="/src/index.js"></script>`

### 3. Environment Variables
- **Prefix thay đổi**: `REACT_APP_*` → `VITE_*`
- **API thay đổi**: `process.env.REACT_APP_*` → `import.meta.env.VITE_*`

Files đã cập nhật:
- `src/services/api.js`
- `src/lib/auth-client.js`
- `src/utils/helpers.js`
- `.env.example`

### 4. Docker Configuration
- **`frontend/Dockerfile`**: Cập nhật build commands
  - `yarn build` sử dụng Vite thay vì react-scripts
  - Build output vẫn trong `/app/build` directory
  - Nginx config đã tối ưu cho Vite assets

### 5. Docker Compose
- **`compose.yml`**: Cập nhật build args và env vars
- **`prod.compose.yml`**: Cập nhật build args và env vars
  - `REACT_APP_API_URL` → `VITE_API_URL` (build args)
  - Environment variables vẫn giữ tên cũ để backward compatibility

## Hướng dẫn sử dụng

### Development (Local)
```bash
cd frontend

# Cài đặt dependencies mới
yarn install

# Chạy dev server (port 3000)
yarn dev

# Build production
yarn build

# Preview build
yarn preview
```

### Production (Docker)
```bash
# Rebuild frontend image
docker compose -f prod.compose.yml build frontend

# Hoặc rebuild toàn bộ
docker compose -f prod.compose.yml up --build -d

# Kiểm tra logs
docker compose -f prod.compose.yml logs frontend
```

## Environment Variables

### Development (.env)
```bash
VITE_API_URL=http://localhost
```

### Production
Trong `prod.compose.yml`, set biến môi trường:
```yaml
REACT_APP_API_URL=https://store.sab.edu.vn
```

**LƯU Ý**: Docker compose vẫn dùng `REACT_APP_API_URL` cho backward compatibility, nhưng được map sang `VITE_API_URL` trong build args.

## Vite Output Structure

Build output trong `/app/build`:
```
build/
├── index.html
├── assets/
│   ├── index-[hash].js      # Main bundle
│   ├── index-[hash].css     # Styles
│   ├── vendor-[hash].js     # React, React Router
│   └── ui-[hash].js         # UI libraries
├── manifest.json
└── *.png (logos, icons)
```

## Nginx Configuration

Frontend container nginx đã được cấu hình để:
- ✅ Serve `/assets/` với long-term cache (1 year)
- ✅ Serve `index.html` với no-cache
- ✅ SPA fallback routing (404 → index.html)
- ✅ Health check endpoint `/health`

## Breaking Changes

### KHÔNG CÒN HỖ TRỢ
- ❌ `%PUBLIC_URL%` trong HTML (dùng `/` thay thế)
- ❌ `process.env.REACT_APP_*` (dùng `import.meta.env.VITE_*`)
- ❌ `.env` files được load tự động bởi CRA

### MỚI HỖ TRỢ
- ✅ `import.meta.env.VITE_*` cho env vars
- ✅ `import.meta.env.MODE` - current mode (development/production)
- ✅ `import.meta.env.DEV` - boolean, true nếu dev mode
- ✅ `import.meta.env.PROD` - boolean, true nếu production mode

## Rollback Plan

Nếu cần rollback về CRA:
```bash
# Checkout commit trước migration
git checkout <commit-hash-before-migration>

# Hoặc revert specific files
git checkout HEAD~1 frontend/package.json
git checkout HEAD~1 frontend/Dockerfile
# ...etc
```

## Testing Checklist

- [ ] `yarn install` chạy thành công
- [ ] `yarn dev` khởi động dev server
- [ ] `yarn build` tạo production build
- [ ] Docker build thành công
- [ ] Assets load đúng (JS, CSS, images)
- [ ] API calls hoạt động
- [ ] Authentication hoạt động
- [ ] Routing hoạt động
- [ ] Production deployment thành công

## Troubleshooting

### Lỗi: "Cannot find module 'vite'"
```bash
cd frontend
rm -rf node_modules yarn.lock
yarn install
```

### Lỗi: Assets 404 Not Found
- Kiểm tra Vite build output trong container
- Verify nginx config serve `/assets/` đúng

### Lỗi: Environment variables undefined
- Kiểm tra prefix: phải là `VITE_` không phải `REACT_APP_`
- Restart dev server sau khi thay đổi `.env`

## Performance Comparison

| Metric | Create React App | Vite |
|--------|-----------------|------|
| Dev Server Start | ~30s | ~1-2s |
| Hot Reload | ~3-5s | <100ms |
| Production Build | ~60-90s | ~10-15s |
| Bundle Size | Larger | Smaller |
