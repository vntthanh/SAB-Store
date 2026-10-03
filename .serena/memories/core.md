# SAB-Store — Core (điểm vào cấp cao nhất)

Cửa hàng lanyard/merch cho SAB: khách đặt hàng online, admin/seller quản lý + bán trực tiếp (POS).
Object storage: SeaweedFS (S3 API), backend dùng SDK `minio` nên biến vẫn tên `MINIO_*`.

**Nguồn sự thật ngoài memory** (memory chỉ tóm tắt, KHÔNG thay thế): `AGENTS.md` (luật cứng) ·
`README.md` · `docs/deployment.md` (runbook cho `prod.compose.yml`, host không Coolify) ·
`docs/ENV_SETUP.md` · `docs/FILE_UPLOAD_SECURITY.md` · comment đầu `coolify.compose.yml`
(ràng buộc Coolify đã đo) · docblock đầu `backend/services/stock.js` và `backend/tests/global-setup.js`.

## Bài học đã đo (đọc TRƯỚC khi suy luận lại)
`mem:lessons/index` — index theo chủ đề (deploy, database, frontend, verification, workflow, machine, sync).

## Nhánh & môi trường
- `main` = production: Coolify (docker.noboroto.id.vn, app `sab-store`, domain store.sabies.vn) build
  kiểu Compose từ `coolify.compose.yml` trên nhánh `main` (backend/frontend build từ source). Đưa `main` lên = deploy.
- `dev` = nhánh làm việc. Lên production: merge `dev` → `main` bằng merge commit (`--no-ff`), **giữ** `dev`
  (không xoá branch), chỉ khi user yêu cầu.

## Lệnh thường dùng
`mem:suggested_commands`. Checklist khi xong việc: `mem:task_completion_checklist`.

## Bảo trì memory
Cấu trúc đồ thị, văn phong, ngưỡng thêm/sửa, cách thêm một bài học: `mem:memory_maintenance`.
