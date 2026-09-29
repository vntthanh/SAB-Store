# Syncthing: repo + .git đồng bộ Mac ↔ Windows

- Không có folder Syncthing riêng cho repo: nằm trong folder chung "Github"
  (Mac ~/Github ↔ Windows D:\Github). Luật ignore ở `~/Github/.stignore-shared`
  (`.stignore` chỉ `#include` nó); file đó ngoài mọi repo và tự đồng bộ. Luật: khớp rule ĐẦU TIÊN.
- SAB-Store: đồng bộ `.git` (chung history) nhưng KHÔNG đồng bộ `*.lock`, `index`, và (từ
  2026-09-29) git state riêng từng máy: `config`, `ORIG_HEAD`, `FETCH_HEAD`, `COMMIT_EDITMSG`, `logs/`.
- Đo 2026-09-29: Mac chạy với config NTFS từ Windows (`core.filemode=false`, `symlinks=false`).
  Đã sửa phía Mac: filemode=true, symlinks=true, precomposeunicode=true (ignorecase=true đúng cho APFS).
- Không bao giờ đặt `(?d)` lên thư mục VCS/index (2026-09-08: `(?d)` xoá `.git` của 173 repo trên Windows).
- `.gitattributes` `* text=auto eol=lf`: CRLF từ một máy thành diff cả file ở máy kia.
- Handoff: một người ghi git tại một thời điểm. Máy A commit xong thì dừng; máy B chờ Syncthing
  "Up to Date", chạy `git reset` (index riêng từng máy), kiểm HEAD + status sạch rồi mới làm.
- Cả hai OS đều không phân biệt hoa thường → đổi hoa/thường tên file phải kiểm trong Docker (Linux).
- Kiểm ignore đã nạp: REST `/rest/db/ignores?folder=<id>` (HTTPS 127.0.0.1:8384, header X-API-Key đọc
  từ config.xml, không in key); pattern trả về đã lower-case với `(?i)`.
