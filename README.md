# SAB Store

> Tên gọi trong code/branding hiện tại là **SAB Store** (xem `frontend/index.html`); "SAB Lanyard" là tên cũ, package.json vẫn giữ `minipreorder-*` làm tên npm package (không đổi, không ảnh hưởng vận hành).

## 🏗️ Kiến trúc hệ thống

- **Backend**: ExpressJS, MongoDB, Better-Auth, REST API, gửi email xác nhận, xuất Excel, bảo mật với Helmet, Rate Limit (có nhưng **tắt mặc định**, xem [Cấu hình môi trường](#-cấu-hình-môi-trường)), CORS.
- **Frontend**: ReactJS (Vite), React Router v6, Context API, TailwindCSS, React Toastify, SweetAlert2. Build tĩnh, gọi API qua path tương đối `/api` — không cần biến môi trường nào lúc runtime hay build.
- **Authentication**: Better-Auth với username/password, session management, role-based access control, admin plugin.
- **Một cổng vào duy nhất**: chỉ `store.sabies.vn` phục vụ cả frontend lẫn `/api/*`; domain `api.store.sabies.vn` riêng đã bị gỡ.
- **Triển khai**: Docker Compose — `compose.yml` (dev) / `prod.compose.yml` (production). Quy trình deploy đầy đủ: [`docs/deployment.md`](docs/deployment.md).

## 🚀 Tính năng

### Khách hàng
- Xem danh sách sản phẩm với giá, hình ảnh chi tiết
- Thêm/bớt sản phẩm vào giỏ hàng với số lượng tuỳ chỉnh
- Đặt hàng với thông tin sinh viên, email, ghi chú đặc biệt
- Theo dõi trạng thái đơn hàng theo mã tracking

### Quản trị viên (Admin)
- **Dashboard**: Thống kê doanh số, đơn hàng, sản phẩm bán chạy
- **Quản lý sản phẩm**: CRUD sản phẩm, quản lý kho, giá, hình ảnh
- **Quản lý sellers**: Tạo/sửa/xoá tài khoản seller, phân quyền
- **Quản lý đơn hàng**: Xem, cập nhật trạng thái, xuất Excel
- **Bán hàng trực tiếp**: POS system cho bán tại quầy

### Sellers
- **Dashboard**: Thống kê đơn hàng của seller
- **Quản lý đơn đặt trước**: Xác nhận, cập nhật trạng thái đơn hàng
- **Bán hàng trực tiếp**: Tạo đơn hàng tại quầy

## 🔐 Hệ thống xác thực (Better-Auth)

### Đăng nhập thống nhất
- **URL duy nhất**: `/login` - Tự động redirect theo role
- **Admin login**: Sau khi đăng nhập → `/admin/dashboard`
- **Seller login**: Sau khi đăng nhập → `/seller/dashboard`
- **Customer**: Không yêu cầu đăng nhập

### Better-Auth API Endpoints

#### Authentication Core
- `POST /api/auth/sign-in/username` - Đăng nhập với username/password
- `POST /api/auth/sign-out` - Đăng xuất
- `GET /api/auth/get-session` - Lấy thông tin session
- `POST /api/auth/update-user` - Cập nhật thông tin user

#### Admin Plugin (User Management)
- `GET /api/auth/admin/list-users` - Danh sách users/sellers
- `POST /api/auth/admin/create-user` - Tạo user mới (role: seller)
- `POST /api/auth/admin/set-role` - Cập nhật role user
- `POST /api/auth/admin/set-user-password` - Đổi password user
- `POST /api/auth/admin/remove-user` - Xoá user
- `POST /api/auth/admin/ban-user` - Ban user
- `POST /api/auth/admin/unban-user` - Unban user

> **Lưu ý**: Các endpoint user management tự động thay thế các API seller management cũ

## ⚙️ Cài đặt

### Yêu cầu hệ thống
- **Docker** & **Docker Compose** (khuyên dùng Docker Desktop)
- **Node.js 18+** (để development)
- **MongoDB** (tự động cài qua Docker)

### Khởi động nhanh với Docker
```bash
# Clone repository
git clone <repository-url>
cd SAB-Store

# Cấu hình environment variables — Docker Compose đọc file .env ở ROOT, không phải backend/.env
cp .env.example .env
# Chỉnh sửa .env theo môi trường của bạn (xem docs/ENV_SETUP.md)

# Khởi động toàn bộ stack (dev)
docker compose up -d --build
```

### Development Setup (Local, không qua Docker)
```bash
# Backend setup
cd backend
cp .env.example .env   # backend/.env.example, không expand ${VAR} — xem docs/ENV_SETUP.md
yarn install
yarn dev       # Port 5000 (nodemon)

# Frontend setup (terminal mới)
cd frontend
yarn install
yarn dev       # Port 3000 (Vite), proxy /api → localhost:5000
```

## 🌐 URLs truy cập

### Local dev (Docker hoặc chạy trực tiếp)
- **Trang chủ**: http://localhost:3000
- **Đăng nhập**: http://localhost:3000/login
- **Admin Dashboard**: http://localhost:3000/admin/dashboard
- **Seller Dashboard**: http://localhost:3000/seller/dashboard
- **API Base**: http://localhost:5000/api (hoặc qua Vite dev proxy: `http://localhost:3000/api`)

### Production
- Một domain duy nhất: `https://store.sabies.vn` — cả trang web lẫn `/api/*` đều qua đó, không còn domain `api.*` riêng.

## 📝 Better-Auth Documentation

Better-Auth cung cấp OpenAPI documentation tự động tại `/api/auth/reference`, nhưng **chỉ khi `NODE_ENV !== production`** (`backend/lib/auth.js`) — plugin `openAPI()` không bật trong production, tránh lộ shape API công khai. Ở local dev (`NODE_ENV=development` mặc định):
- **API Docs**: http://localhost:5000/api/auth/reference
- **Admin API Docs**: Endpoints dạng `/api/auth/admin/*`

### Ví dụ sử dụng Admin Plugin
```javascript
// Frontend - Lấy danh sách sellers
const { data: sellers } = await authClient.admin.listUsers({
  filterField: 'role',
  filterValue: 'seller'
});

// Frontend - Tạo seller mới
const { error } = await authClient.admin.createUser({
  email: 'seller@example.com',
  password: 'password123',
  name: 'Tên Seller',
  role: 'seller',
  data: { username: 'seller_username' }
});
```

## 🔧 Cấu hình môi trường

Không biến nào ở trên từng đúng với code hiện tại — `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DB_NAME`, `EMAIL_*` **không được code đọc ở đâu cả**, và frontend **không có** file `.env`/biến `REACT_APP_API_URL` (SPA gọi API qua path tương đối `/api`, không cần domain nào baked vào bundle — `VITE_API_URL` đã bị xóa hẳn, không phải đổi tên).

Danh sách biến thật, có chú thích tại chỗ giải thích từng biến: [`.env.example`](.env.example) (đọc bởi `docker compose`, ở **root** repo) và [`backend/.env.example`](backend/.env.example) (chỉ dùng khi chạy backend trực tiếp, không qua Docker). Chi tiết + lý do gộp/không gộp: [`docs/ENV_SETUP.md`](docs/ENV_SETUP.md).

Tóm tắt các biến bắt buộc (production, thiếu 1 biến là container **không boot**): `PUBLIC_URL`, `JWT_SECRET`, `MONGODB_URI`, `MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `ADMIN_EMAIL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `APPSCRIPT_URL`. `CORS_ORIGIN`/`BASE_URL` không set riêng — cả hai nội suy từ `PUBLIC_URL`.

## 🐳 Docker Configuration

Hệ thống sử dụng `compose.yml` (dev) / `prod.compose.yml` (production) — **đúng 4 services**, không có service `nginx` riêng:

- **mongodb**: Database chính
- **minio**: Object storage cho hình ảnh sản phẩm
- **backend**: ExpressJS API server (internal port 5000)
- **frontend**: React (Vite) build, **nginx nằm bên trong image này** (`frontend/Dockerfile` build từ `nginx:alpine`, internal port 80) — không phải service tách biệt

Production chỉ có một cổng vào: `store.sabies.vn` → NPM → container `frontend` (nginx) → `backend:5000` cho `/api/*`, → `minio:9000` trực tiếp cho `/uploads/*` (không qua backend). Domain `api.store.sabies.vn` riêng đã bị gỡ.

```yaml
# nginx trong container frontend
Client Request
        ↓
  [nginx trong frontend]
        ├─→ /api/*        → backend:5000 (API requests)
        ├─→ /uploads/*    → minio:9000 (ảnh sản phẩm, đọc trực tiếp từ object storage)
        └─→ /*             → static build (React app)
```

### Ưu điểm kiến trúc Nginx
- **Giảm tải NodeJS**: Nginx phục vụ static files, cache responses
- **Tối ưu performance**: Gzip compression, keepalive connections
- **Security headers**: `frontend/security-headers.conf` (CSP hiện **report-only**, chưa enforcing — xem `docs/deployment.md`). Rate limiting nằm ở tầng backend (Express), **không** ở nginx, và tắt mặc định.
- **Caching**: Static assets cached 7 days, API không cache

## 🧪 Testing & Validation

Không package nào có script `lint` (`backend/package.json`, `frontend/package.json`) — bỏ qua bước đó. Chạy test:

```bash
# Backend (Jest)
cd backend && npx jest

# Frontend (Vitest)
cd frontend && yarn test
```

### Kiểm tra Better-Auth integration
1. Truy cập `/login` và đăng nhập với admin account
2. Kiểm tra redirect tự động đến admin dashboard
3. Thử các chức năng quản lý seller qua Admin Plugin
4. Kiểm tra session management và logout

## 📊 Monitoring & Logs

### Development Logs
```bash
# Xem logs tất cả services
docker compose logs -f

# Chỉ xem logs backend
docker compose logs -f backend

# Chỉ xem logs database
docker compose logs -f mongodb
```

### Production Monitoring
- Backend log ra `console.*` (`backend/utils/errorLogger.js`) — **không** ghi file, không có thư mục `logs/`. Xem log qua `docker compose logs -f backend`; container giới hạn `max-size: 10m`, `max-file: 3` (json-file driver).
- Better-Auth session management tự động
- Database connection status qua health endpoints (`/health`)

## 🚀 Deployment

Quy trình đầy đủ, có kiểm chứng và đúng thứ tự: **[`docs/deployment.md`](docs/deployment.md)**. Tóm tắt:

```bash
# LUÔN dùng -f prod.compose.yml (không phải compose.prod.yml), build từng service:
docker compose -f prod.compose.yml build backend
docker compose -f prod.compose.yml build frontend
docker compose -f prod.compose.yml up -d
```

### Environment Variables cho Production
- Set `PUBLIC_URL=https://store.sabies.vn` — `CORS_ORIGIN`/`BASE_URL` tự nội suy theo, không set riêng
- Dùng secret dài, ngẫu nhiên cho `JWT_SECRET` (không có `BETTER_AUTH_SECRET` trong code)
- Mọi secret khác (`MONGODB_URI`, `MONGO_INITDB_ROOT_PASSWORD`, `MINIO_ROOT_PASSWORD`, `ADMIN_PASSWORD`, `APPSCRIPT_URL`) đều bắt buộc — thiếu 1 là container không boot
- HTTPS do NPM (Nginx Proxy Manager) đứng trước xử lý, ngoài phạm vi compose file này

## 🤝 Contributing

1. Fork repository
2. Tạo feature branch: `git checkout -b feature/ten-tinh-nang`
3. Commit changes với convention: `feat(scope): description`
4. Push branch và tạo Pull Request
5. Đảm bảo tất cả tests pass trước khi merge

## 📞 Support

- **Issues**: Tạo GitHub Issues cho bugs/features
- **Documentation**: [`docs/`](docs/) — deploy runbook, env setup, upload security
- **API Reference**: OpenAPI spec tự động generate tại `/api/auth/reference`, chỉ khi `NODE_ENV !== production`