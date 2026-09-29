# SAB-Store — Core (điểm vào cấp cao nhất)

Cửa hàng lanyard/merch cho SAB: khách đặt hàng online, admin/seller quản lý + bán trực tiếp (POS).
Tên project trong Serena là "SAB-Lanyard" (tên lịch sử), repo là SAB-Store.

**Nguồn sự thật ngoài memory** (memory chỉ tóm tắt, KHÔNG thay thế): `AGENTS.md` (luật cứng) ·
`README.md` · `docs/deployment.md` (runbook cho `prod.compose.yml`, host không Coolify) ·
`docs/ENV_SETUP.md` · `docs/FILE_UPLOAD_SECURITY.md` · comment đầu `coolify.compose.yml`
(ràng buộc Coolify đã đo) · docblock đầu `backend/services/stock.js` và `backend/tests/global-setup.js`.

## Bài học đã đo (đọc TRƯỚC khi suy luận lại)
`mem:lessons/index` — index theo chủ đề (deploy, database, sync).

## Nhánh & môi trường
- `main` = production: Coolify (docker.noboroto.id.vn, app `sab-store`, domain store.sabies.vn) build
  kiểu Compose từ `coolify.compose.yml` trên nhánh `main`. Push `main` = deploy.
- `dev` = nhánh làm việc. Chỉ merge vào `main` khi user yêu cầu.

## Lệnh thường dùng
`mem:suggested_commands`. Checklist khi xong việc: `mem:task_completion_checklist`.

## Bảo trì memory
Memory sai/cũ thì sửa hoặc xoá ngay. Không ghi version/số đếm (đọc manifest). Bài học mới: ghi
vào `lessons/<topic>/<slug>` + thêm một dòng vào `lessons/index`.
