# Doanh thu < 100 triệu VND — không lo tràn int32

- Tổng `::int` và cột tiền kiểu Int là đủ (2^31 ≈ 2,1 tỷ). Không nêu phát hiện tràn số trên tổng tiền, không thêm xử lý bigint; báo reviewer đây là ngoài phạm vi.
- Giữ một comment ngắn ở chỗ tổng int ghi giả định này.

**Why:** 12/10/2026, reviewer gắn cờ rủi ro tràn `SUM(...)::int`; owner: "chắc chắn doanh thu không bao giờ vượt qua 100tr, không cần quan tâm".
