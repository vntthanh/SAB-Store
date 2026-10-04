# Transaction MongoDB — từ standalone sang replica set (đã đo)

- Tới 04/10/2026 production là mongod standalone: transaction throw lúc chạy, trong khi harness test
  (`backend/tests/global-setup.js`, MongoMemoryReplSet) cho xanh. `rs.initiate` trên mongo có `--auth`
  crash nếu thiếu `--keyFile`.
- 04/10/2026 19:36 production chuyển sang replica set 1 node `rs0` (deploy 77, merge 06df0f7): đo được
  `hello.setName=rs0`, `isWritablePrimary`, số document mọi collection khớp backup, transaction thử commit được.
  Keyfile sinh từ env `MONGO_REPLICA_KEY` trong `command:` vào `/etc/mongo` (thư mục phải `chmod 755` vì
  `umask 077`; không đặt `/tmp` — `mem:lessons/deploy/seaweedfs_restart_protected_regular`).
- Đã tập dượt cục bộ: chuyển đổi data dir standalone có auth giữ nguyên dữ liệu; sống qua 2 lần `docker restart`;
  rollback về standalone trên cùng data dir khởi động được.
- Backend kiểm `hello.setName` lúc boot (`backend/lib/require-replica-set.js`): rollback hạ tầng phải revert cả phần này.
- Key base64 phải không xuống dòng: `openssl rand -base64 756` gói dòng 64 ký tự → `| tr -d '\n'`.
- `docker compose config` điền sẵn giá trị env vào output: muốn thử "key rỗng" thì chạy lệnh trực tiếp, đừng tái dùng config đã render.
