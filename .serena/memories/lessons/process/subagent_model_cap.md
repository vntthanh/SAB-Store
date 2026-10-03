# Trần model cho subagent (luật của owner, đặt 17/09/2026; chung cho Leaderboard/JudgeHub/QR/SAB)

- Mọi lệnh Agent/Task phải truyền `model: "sonnet"` TƯỜNG MINH. Bỏ trống → subagent thừa hưởng model của orchestrator (opus).
- `opus` chỉ cho advisor `kongming` hoặc vòng leo thang sau 3 vòng sonnet hỏng trên cùng việc. Tối đa MỘT subagent opus cùng lúc.
- Không bao giờ dùng `fable` cho subagent. `kongming` mặc định fable → override `model: "opus"`.
- Lỡ spawn subagent opus → dừng ngay, spawn lại bằng sonnet.

**Why:** subagent opus đốt quota của owner; một lần 429 đã giết agent implement giữa phase.
**How to apply:** trước mỗi lệnh Agent, kiểm có `model: "sonnet"` (hoặc lý do opus hợp lệ ở trên). Áp cả cho agent review read-only.
