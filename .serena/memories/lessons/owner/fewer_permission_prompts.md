# Ít lệnh nhạy cảm (prompt xin quyền)

- Sửa file repo/plan bằng Edit/Write, không `python3 - <<EOF` hay `sed -i`; ghi memory bằng Write/`write_memory`, không heredoc.
- Dùng lại một script helper cố định trong scratchpad (vd `commit-locked.sh`, `lock.sh`), không đẻ script mới trong `/tmp` mỗi lần.
- Tránh `kill`, `rm -rf`, `docker rm`, `ssh` trừ khi việc cần; cần thì gộp vào một lệnh.
- Đọc/kiểm tra qua Read và MCP trước Bash. Nhắc luật này cho subagent.

**Why:** 12/10/2026 owner: "Tôi thấy bạn yêu cầu sensitive command hơi nhiều" — phiên đó chạy nhiều python/sed, heredoc, docker, kill và script tmp mới.
