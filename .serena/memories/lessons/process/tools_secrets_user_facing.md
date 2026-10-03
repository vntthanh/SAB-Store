# Tool, secret, giao tiếp với user (luật của owner, chung Leaderboard/JudgeHub/QR/SAB)

## Tool
- MCP trước: serena (symbol, memory) · code-review-graph (kiến trúc, context diff) · context7 (docs thư viện) · Playwright MCP (trình duyệt). Built-in (Read/Grep) thứ hai, Bash cuối — nhưng Bash vẫn đúng cho git, package manager, test, build. Nhắc lại luật này trong MỌI prompt subagent.
- Không viết script puppeteer/playwright để test; dùng MCP.

## Secret
- Không in secret, file credential, hay config compose/env đã render. Dùng `[redacted]`.
- GitGuardian: token giả cho test để trong file có tên, liệt kê ở `.gitguardian.yaml` (`version: 2`, `secret.ignored_paths`). Không bao giờ ignore cả cây test.

## User
- Trả lời user bằng tiếng Việt.
- Chỉ hỏi user quyết định sản phẩm hoặc hành động không đảo ngược được; còn lại orchestrator tự quyết.
