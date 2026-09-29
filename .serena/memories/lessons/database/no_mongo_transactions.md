# Không transaction MongoDB

- Production: mongod standalone, không replica set (`rs.initiate` crash mongo khi không có keyfile —
  đã thử). Transaction throw lúc chạy.
- Harness test (`backend/tests/global-setup.js`): MongoMemoryReplSet 1 node → transaction PASS trong
  test. Test xanh không chứng minh được gì ở đây.
- Invariant giữ bằng một `findOneAndUpdate` có điều kiện + bù trừ khi hỏng giữa chừng
  (`backend/services/stock.js`: `deductStockForItems` hoàn lại theo thứ tự ngược trong catch).
- Service nhận `session` tuỳ chọn, nullable; `null` là chế độ chuẩn hiện tại.
