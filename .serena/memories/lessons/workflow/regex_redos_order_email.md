# Regex email kiểu `\w+([.-]?\w+)*@` backtrack theo hàm mũ

- Regex email cũ của đơn hàng `\w+([.-]?\w+)*@` làm một request mất 249 s (đo) với chuỗi dài không có `@` → ReDoS, một request chiếm cả event loop.
- Đã thay bằng bản tuyến tính tương đương. **Apply:** gặp nhóm lặp lồng `(x?x+)*` hay `\w+([.-]?\w+)*` thì viết lại thành `\w+(?:[.-]\w+)*` hoặc dùng validator chung (`isValidEmail` ở `@sab/shared`).
- Còn sót: `backend/models/Order.js` (đường Mongo) vẫn dùng dạng cũ; chỉ Mongo, không ở đường Postgres — sửa khi đụng file đó.
