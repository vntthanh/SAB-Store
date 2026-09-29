# Coolify compose — ràng buộc đã đo

Nguồn: comment đầu `coolify.compose.yml` + commit message của file đó. Đọc file trước khi sửa.

- `${VAR:?message}` KHÔNG được Coolify hỗ trợ: nó thay biến bằng chính chuỗi message thay vì fail
  (đo 2026-09-21: backend crash-loop vì base URL không hợp lệ; DB suýt nhận password là chuỗi lỗi).
  → chỉ dùng `${VAR}` trơn; giá trị nằm trong kho env của Coolify.
- Coolify đổi tên mọi named volume khai trong compose → tách DB/MinIO/upload khỏi dữ liệu.
  → bind tuyệt đối dưới /srv/appdata/vol/.
- Coolify đăng ký TÊN SERVICE làm network alias; nginx của frontend proxy tới `sabstore-backend:5000`
  → service backend tên `sabstore-backend`. Không `networks:`, không `container_name:`.
- Build từ source từng lỗi `vite: not found` do drift dependency → backend/frontend chạy image
  pre-built từ registry cục bộ trên host; Coolify chạy `compose pull` trước `up`.
- Mỗi service bị giới hạn CPU để một build/runaway không bóp các stack khác trên host.
- Coolify UI: chỉ đọc qua claude-in-chrome; không bấm Save/Deploy khi user chưa yêu cầu.
