# Gian hàng và quyền truy cập (dành cho admin)

Tài liệu này giải thích cách vận hành, không mô tả giao diện từng nút. Quy tắc nằm ở
`backend/services/storefront-access.js`; API admin ở `backend/routes/admin/storefronts.js`.

## Gian hàng

- Mỗi sản phẩm thuộc đúng một gian hàng; combo có thể thuộc nhiều gian hàng. Khách thấy mỗi gian
  hàng thành một tab trên trang cửa hàng.
- **Công khai (PUBLIC)**: ai cũng xem và đặt hàng được, không cần đăng nhập, như cửa hàng trước đây.
- **Riêng tư (PRIVATE)**: chỉ người đăng nhập bằng email đã xác minh và được một quy tắc cho phép
  mới đặt hàng được.
- Thứ tự tab là thứ tự admin sắp xếp bằng nút lên/xuống ở trang Gian hàng (lưu qua
  `PUT /api/admin/storefronts/reorder`).
  Gian hàng tắt (`isActive`) không hiện cho khách.
- Đường dẫn (slug) gồm chữ thường, số, dấu gạch ngang; không trùng nhau.
- **Gian hàng mặc định** (`cua-hang`) chứa toàn bộ dữ liệu có từ trước khi có tính năng này và
  **không xoá được**. Gian hàng đang có sản phẩm, combo hoặc đơn, và gian hàng đang hoạt động cuối
  cùng, cũng không xoá được (trả 409).

## Quy tắc truy cập (gian hàng riêng tư)

Có ba loại quy tắc, gộp theo **HOẶC**: khớp một quy tắc là được vào.

| Loại | Khớp khi |
|------|----------|
| Email | đúng địa chỉ đó (không phân biệt hoa thường) |
| Tên miền | phần sau `@` **đúng bằng** tên miền (ví dụ `school.edu.vn`); tên miền con như `a.school.edu.vn` không khớp |
| Danh sách email (chip "Danh sách") | địa chỉ nằm trong danh sách email đã tạo |

Quy tắc có hiệu lực ngay ở yêu cầu kế tiếp: gỡ quy tắc là chặn ngay, không có bộ nhớ đệm. Email
chưa xác minh không bao giờ khớp quy tắc nào.

### Danh sách email

- Tạo danh sách riêng (tên không trùng), dùng lại cho nhiều gian hàng.
- Thêm địa chỉ bằng cách dán, hoặc nạp file CSV / XLSX (tối đa 5 MB; file `.xls` cũ không đọc
  được, lưu lại thành `.xlsx`); hệ thống xem trước kết quả (hợp lệ,
  trùng, sai định dạng) rồi mới lưu. Mỗi lần gửi tối đa **5000** địa chỉ; danh sách lớn hơn thì
  chia thành nhiều lần.
- Địa chỉ được chuẩn hoá về chữ thường; địa chỉ trùng trong danh sách bị bỏ qua.

## Ai xem, ai đặt hàng

- **Xem** danh mục: gian hàng công khai thì ai cũng xem. Staff (admin, seller) xem trước mọi gian
  hàng, kể cả riêng tư hay đã tắt, để kiểm tra trước khi mở.
- **Đặt hàng** ở gian hàng riêng tư: chỉ người nằm trong danh sách cho phép. Staff xem trước nhưng
  không đặt đơn online thay khách.
- Gian hàng đã tắt thì không ai đặt được, kể cả staff.
- Một đơn online chỉ chứa sản phẩm của **một** gian hàng; giỏ lẫn nhiều gian hàng bị từ chối.
- Giá và tổng tiền luôn tính lại ở server; khách không đặt được hàng của gian hàng mà mình không
  có quyền, dù gửi trực tiếp lên API.

## Đăng nhập

- **Khách**: nhập email nhận mã một lần (hết hạn sau 5 phút, tối đa 5 lần thử, có giới hạn số mã
  gửi cho mỗi địa chỉ và cho cả cửa hàng), hoặc dùng Google One Tap. Khách không cần mật khẩu.
- **Staff** (admin, seller): đăng nhập bằng tên đăng nhập + mật khẩu như trước. Có thể dùng thêm mã
  email hoặc Google **sau khi** email của tài khoản được xác minh. Tài khoản staff tạo từ giờ do
  admin nhập email nên được coi là đã xác minh; tài khoản cũ cần chạy bước xác minh trong
  [`deployment.md`](deployment.md). Tài khoản chưa xác minh bị từ chối ở mã/Google và vẫn dùng mật khẩu.
- Vì sao cần xác minh: mã email chứng minh người nhập kiểm soát hộp thư. Với tài khoản staff, địa
  chỉ sai hoặc là địa chỉ giả sẽ trao quyền cho chủ hộp thư đó, nên admin phải duyệt trước.

## Yêu cầu hệ thống

- **Bật SMTP** ở trang Cài đặt: không có SMTP thì không gửi được mã, khách không đăng nhập bằng mã
  được. Cấu hình SMTP: [`ENV_SETUP.md`](ENV_SETUP.md).
- **Google Client ID** (tuỳ chọn) ở trang Cài đặt để hiện nút Google; để trống thì ẩn. Cách tạo:
  [`ENV_SETUP.md`](ENV_SETUP.md).
