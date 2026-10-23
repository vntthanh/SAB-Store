# "Backup/restore" = export/import trên admin dashboard

- Nghĩa là trang DatabaseManagement → `GET /api/admin/database/export` / `POST /api/admin/database/import`. KHÔNG phải backup định kỳ hay cron dump trên host.
- Việc cần làm khi được yêu cầu: round-trip export → import chạy đúng qua API và UI.
- Không đề xuất backup định kỳ. `pg_dump` trước migrate trong `release.sh` là chuyện riêng, giữ nguyên.

**Why:** 11/10/2026, sau yêu cầu "đảm bảo backup và restore hoạt động" agent đã dựng cron + script dump; owner: "Tôi không cần sao lưu định kỳ, cái tôi cần là tính năng trên admin dashboard như cái đã có sẵn".
