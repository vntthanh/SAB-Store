# Memory Maintenance

## Discovery model
- `mem:core` là gốc của đồ thị memory; nó trỏ tới memory theo mảng lớn, các memory đó trỏ tiếp tới memory hẹp hơn.
- Nhóm bằng thư mục chủ đề (`lessons/<topic>/...`). Tham chiếu luôn viết `mem:<tên>` trong backtick, kèm câu nói rõ đọc khi nào / chứa gì (không chỉ lặp tên).
- Bản thân memory không ghi "đọc khi nào" — đó là việc của memory trỏ tới nó.

## Style
Ghi chú dày đặc cho agent, không phải văn xuôi. Invariant + bullet ngắn. Chỉ giữ lý do/ví dụ khi nó chặn được một lỗi dễ mắc.

## Ngưỡng thêm/sửa
Chỉ ghi quy ước ổn định, không hiển nhiên, đỡ phải dò lại tốn công. KHÔNG ghi: fact đọc nhanh từ code/manifest; kiến thức framework chung; ghi chú một lần; chi tiết cấp dòng dễ đổi; version/số đếm; thứ tạm thời có hạn (vd quyền ưu tiên khoá máy có giờ kết thúc).

## Cây lessons (`lessons/*`)
- Một memory = một sự thật ĐÃ ĐO, có **Why** (bằng chứng, ngày) và **How to apply**.
- Thêm bài học = ghi vào `lessons/<topic>/<slug>` VÀ thêm một dòng vào `mem:lessons/index` dưới đúng chủ đề.
- Không gộp nội dung bài học vào `core`/`suggested_commands`; những memory đó chỉ trỏ tới.
- Memory sai/cũ: sửa hoặc xoá ngay, cập nhật index cùng lúc. Đổi tên bằng tool rename của Serena để tham chiếu tự cập nhật.
