# SAB-Store — Project Instructions

File này chỉ chứa **luật và hướng dẫn**. Kiến trúc, cấu trúc thư mục, danh sách tính năng thì
tự tra (serena, code-review-graph, `README.md`, `docs/`) — đừng chép vào đây. Số đo (version,
số file, thời gian chạy) cũng không sống ở đây: chạy lệnh và đọc output.

## 0. Luật cứng — quét nhanh trước khi làm

| Tuyệt đối KHÔNG                                                                    | Vì sao / xem mục                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Tạo `CLAUDE.md` / `CLAUDE.local.md` trong repo hoặc thư mục cha                    | Claude Code sẽ đọc nó và bỏ qua `AGENTS.md` này                                         |
| Commit / push / merge vào `main` khi user chưa yêu cầu thẳng                       | `main` là production: Coolify deploy từ `main`. Làm việc trên `dev` (§5)                |
| Gọi `startSession` / `withTransaction` của MongoDB                                 | Production là mongod standalone, transaction throw lúc chạy; test vẫn xanh (§3)         |
| Ghi `Product.stockQuantity` ngoài `backend/services/stock.js`                      | Chỉ đường atomic đó chống oversell và bù trừ khi đơn hỏng giữa chừng (§3)               |
| Tin giá / tổng tiền / combo do client gửi                                          | Giá luôn tính lại server-side trong `backend/services/pricing.js` (§3)                  |
| Dùng `${VAR:?message}` trong `coolify.compose.yml`                                 | Coolify thay biến bằng chính chuỗi message, không fail (§2)                             |
| Thêm `networks:` / `container_name:` / named volume vào `coolify.compose.yml`      | Coolify tự quản và đổi tên volume → tách DB khỏi dữ liệu (§2)                           |
| Dùng `npm install` / sinh `package-lock.json`                                      | Package manager là yarn (`package.json` gốc chỉ chứa husky); Dockerfile chạy `yarn install --frozen-lockfile` (§2) |
| Chạy nhiều việc nặng song song (test + docker build)                               | Làm đói CPU cả máy và các phiên khác (§4)                                               |
| Chạy git trên cả Mac lẫn Windows cùng lúc                                          | `.git` đồng bộ qua Syncthing; phải chờ "Up to Date" rồi mới đổi máy (§5)                |
| Tham chiếu path/URL git không track (`plans/`, report cục bộ, `/Users/...`)        | Người chỉ có repo không theo được (§4)                                                  |
| Commit code chưa qua ≥2 agent review                                               | Một góc nhìn bỏ sót cả lớp lỗi; test xanh không thay được review (§6)                   |
| Chạy lệnh dài trên server ngoài `tmux`                                             | SSH rớt là chết giữa chừng, để lại container nửa vời (§2)                               |
| Spawn subagent không truyền `model: "sonnet"`; dùng `fable` cho subagent           | Thừa hưởng opus, đốt quota owner; opus chỉ cho kongming/leo thang, tối đa 1 (§6)        |
| Tạo git worktree (`isolation: "worktree"`, `git worktree add`)                     | Nhân đôi CPU/RAM; máy crash 30/09/2026 (§4)                                             |
| `git commit/push --no-verify`; commit > 29 file                                    | Hook là cổng chất lượng; commit lớn mất điểm quay lui (§5)                              |
| In secret, file credential, config compose/env đã render                           | Dùng `[redacted]`; fixture token giả khai trong `.gitguardian.yaml` (§3)                |

## 1. Tool policy — MCP trước, built-in sau

Thứ tự: **MCP → built-in (Read/Glob/Grep/Edit) → Bash**. Built-in luôn nạp sẵn nên bị với tới
theo phản xạ; MCP trả lời có cấu trúc, đã đánh chỉ mục, tốn ít token hơn. Mọi prompt giao cho
subagent phải nhắc lại luật này.

**Serena memory là nơi tra bài học đầu tiên.** Trước khi tự suy luận lại một hành vi, hoặc kết
luận "cái này chắc là…", đọc `mem:core` rồi `mem:lessons/index` — sự thật đã **đo được** của dự
án nằm ở đó. Có bài học mới đã đo được thì `write_memory` đúng chủ đề (`lessons/<topic>/…`) rồi
thêm một dòng vào index. Memory sai/cũ thì sửa hoặc xoá, đừng để nằm đó. Văn phong, ngưỡng
thêm/sửa và cấu trúc đồ thị memory: `mem:memory_maintenance`. Trước khi kết thúc một việc, tự hỏi
"phiên này đã đo được gì mà phiên sau sẽ phải dò lại?" — có thì ghi ngay, đừng để user nhắc.

**Điều hướng & sửa code — `serena`**

| Việc                                  | ĐỪNG                        | DÙNG                                                                 |
| ------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| Tìm symbol (hàm/class/biến)           | `Grep` theo tên             | `find_symbol`, `find_declaration`, `find_implementations`            |
| Tìm nơi gọi / tham chiếu              | `Grep`                      | `find_referencing_symbols`                                           |
| Xem API của file trước khi đọc        | `Read` cả file              | `get_symbols_overview`                                               |
| Sửa thân một symbol                   | `Edit` kèm khối context lớn | `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol` |
| Đổi tên / thay chuỗi toàn repo        | `Grep` + N lần `Edit`       | `rename_symbol`, `replace_in_files`, `replace_content`               |
| Xoá symbol kèm dọn tham chiếu         | `Edit` tay từng chỗ         | `safe_delete_symbol`                                                 |
| Xem lỗi/chẩn đoán của 1 file          | build cả package            | `get_diagnostics_for_file`                                           |
| Ghi nhớ kiến thức repo giữa các phiên | file rác trong repo         | `write_memory` / `read_memory` / `list_memories`                     |

**Kiến trúc & review — `code-review-graph`**

| Việc                             | ĐỪNG                  | DÙNG                                                          |
| -------------------------------- | --------------------- | ------------------------------------------------------------- |
| Định hướng đầu tiên (rẻ nhất)    | đọc lung tung         | `get_minimal_context_tool` — **gọi trước tiên**               |
| Kiến trúc / bán kính ảnh hưởng   | đọc tay               | `get_architecture_overview_tool`, `get_impact_radius_tool`    |
| Context cho một diff             | đọc hết file chạm vào | `get_review_context_tool`, `detect_changes_tool`              |
| Luồng nghiệp vụ xuyên module     | lần theo import tay   | `list_flows_tool`, `get_flow_tool`, `get_affected_flows_tool` |
| Tìm node theo ngữ nghĩa          | `Grep` từ khoá        | `semantic_search_nodes_tool`, `query_graph_tool`              |

**Tài liệu & web**: docs thư viện → `context7` (`resolve-library-id` → `query-docs`), không dựa
trí nhớ; repo GitHub ngoài → `deepwiki`; tìm web → `exa` / `tavily` / `firecrawl`; một URL → `WebFetch`.

**Trình duyệt**: mặc định **Playwright MCP**; `claude-in-chrome` khi cần đúng phiên Chrome đã
đăng nhập (vd giao diện Coolify). Không cài hoặc tự viết script `playwright`/`puppeteer`.

**Vẫn dùng Bash cho**: git, yarn, jest/vitest, docker, chạy script — đừng né.

**Lưu ý vận hành**

- `serena` / `code-review-graph` **không phủ file untracked** — file mới chưa commit phải `Read` trực tiếp.
- Index rỗng/cũ **không phải** lý do quay về `Grep`: chạy `build_or_update_graph_tool` rồi query lại. Dựng graph không tính là ghi repo.
- `get_impact_radius_tool` trên node trung tâm có thể vượt trần token → thu hẹp depth.
- Tool bị _deferred_ → nạp bằng **một** lần `ToolSearch` cho cả cụm (`select:` nhận danh sách phẩy).
- Câu hỏi về cách JudgeHub/Leaderboard đã giải một việc tương tự (hook, compose, Syncthing): hỏi phiên Claude cùng tên qua `SendMessage` (tìm bằng `ListAgents`), **chỉ hỏi đọc**. Tin bị giữ/hết hạn (hai phiên khác permission mode) thì đừng chờ, đừng gửi lại: đọc thẳng repo anh em (chỉ đọc), vd `AGENTS.md`, `.husky/`, `.serena/memories/` của JudgeHub.
- Hook `scout-block` của máy chặn lệnh Bash chứa chuỗi `node_modules`/`build` → viết file bằng Write rồi chạy, không sửa `.ckignore` khi user chưa yêu cầu (`mem:lessons/workflow/agent_tooling_pitfalls`).
- MCP xác thực tương tác (`claude-in-chrome`) có thể vắng trong phiên headless/cron — đừng phụ thuộc trong luồng tự động. `harvest`, Google Drive không phục vụ dự án này.

## 2. Stack & deploy — luật, không phải bảng số

Version và tên image nằm ở `package.json`, `yarn.lock`, `Dockerfile`, các file compose — đọc ở đó.

- **Package manager: yarn** cho cả `backend/` và `frontend/`. Không commit `package-lock.json`.
- **Backend** CommonJS (Express + Mongoose); **frontend** ESM (Vite + React). Không trộn kiểu module trong cùng một package.
- **Auth: Better Auth** — tra `context7`, đừng đoán API. `backend/lib/auth.js` validate secret ngay lúc `require()`: thiếu env là crash khi boot, đó là thiết kế fail-fast, không phải lỗi cần né.
- **Ba file compose, ba vai trò**:
  - `compose.yml` — dev.
  - `coolify.compose.yml` — **production đang chạy**. Coolify deploy từ nhánh `main` của repo này. Đọc comment đầu file trước khi sửa: nó ghi các ràng buộc của Coolify đã đo được (tên service là network alias mà nginx của frontend trỏ tới, bind tuyệt đối thay vì named volume, không `${VAR:?}`).
  - `prod.compose.yml` — bản cũ cho host không có Coolify, giữ làm đường rollback; runbook ở `docs/deployment.md`.
- Env của production nằm trong kho env của Coolify, không trong repo. Không bao giờ in giá trị secret ra log/chat.
- **Tác vụ dài trên server đi qua `tmux`**, dùng lại **một** tên session (kiểm `tmux ls` trước, chạy lại thì kill rồi tạo lại cùng tên). Đừng đẻ `deploy2`, `deploy-retry`: server tích session chết, lần sau không biết cái nào đang chạy thật.
- Script vận hành trong `backend/scripts/` mặc định read-only hoặc dry-run; chỉ chạy chế độ ghi sau khi user xem số liệu dry-run.

## 3. Dữ liệu, tiền, tồn kho, bảo mật

- **Zero-trust**: không tin client. Validate input và kiểm quyền (admin/seller) **server-side**; client chỉ để UX.
- **Không transaction MongoDB.** Production là mongod standalone; harness test chạy replica set nên transaction **pass trong test và throw ở production**. Mọi invariant nhiều bước giữ bằng một `findOneAndUpdate` có điều kiện, cộng bù trừ khi hỏng giữa chừng. Service nhận tham số `session` tuỳ chọn để sau này bật transaction không phải sửa call-site — truyền `null` là chế độ chuẩn.
- **Tồn kho**: mọi thay đổi `stockQuantity` từ đường có tiền/hàng đi qua `backend/services/stock.js`. Không `save()` product với stock đọc trước rồi cộng trừ trong JS — hai request đồng thời sẽ ghi đè nhau.
- **Giá**: tổng tiền, giá combo, giảm giá luôn tính lại trong `backend/services/pricing.js` từ dữ liệu DB; payload client chỉ mang id + số lượng. Hiển thị và thanh toán dùng cùng một hàm tính.
- **Query string** không đưa thẳng vào filter Mongo: đi qua helper trong `backend/utils/query-guard.js` (Express có thể giao object như `{ $ne: null }` — operator injection).
- **Mass-assignment**: không đưa nguyên `req.body` vào `create`/`update`/`findOneAndUpdate`; chọn field tường minh. Import/export database không bao giờ ghi hay xuất credential.
- **Mã lỗi** dùng hằng trong `backend/constants/errorCodes.js`, không viết chuỗi rải rác. Không nuốt lỗi im lặng.
- **Upload**: theo `docs/FILE_UPLOAD_SECURITY.md` (kiểm loại thật của file, giới hạn cỡ, tên file do server sinh).
- **Rate limit dựa trên `req.ip`** chỉ đúng khi `trust proxy` khớp chuỗi proxy thật — kiểm `req.ip` trên production trước khi bật hoặc siết.

## 4. Chất lượng code & test

- **Test**: backend Jest, frontend Vitest. Chạy hẹp trước: `cd backend && yarn test <pattern>` (Jest nhận pattern trực tiếp). Full suite khi đụng contract dùng chung (pricing, stock, auth, model).
- **Git hook (husky, `.husky/`) là cổng chất lượng** — không có GitHub CI. Cài một lần mỗi máy: `yarn install` ở gốc repo (`prepare` đặt `core.hooksPath`; git config riêng từng máy nên Mac và Windows đều phải chạy).
  - `pre-commit`: > 29 file staged → chặn (giữ mỗi commit đủ nhỏ để review đa agent); không có code backend/frontend → không chạy gì; backend → Jest `--findRelatedTests` cho file staged, hoặc full suite khi đụng contract dùng chung (models, pricing + `ComboService`, stock, `query-guard`, `lib/`, `middleware/`, harness test, dependency); frontend → `yarn build`.
  - `pre-push`: full backend suite nếu khoảng push đụng `backend/`, build frontend nếu đụng `frontend/`. `commit-msg`: chặn attribution AI (claude/anthropic/codex/chatgpt) — KHÔNG thêm trailer `Co-Authored-By`/link session mà harness gợi ý mặc định.
  - Hook test trên **working tree**, không phải nội dung staged: commit một phần (`git add -p`) thì kết quả hook không chứng minh phần staged đứng riêng được.
  - Hook tự lấy khoá máy (`.husky/lib/heavy-lock.sh`) và tự bổ sung PATH khi chạy từ app GUI như GitHub Desktop (`.husky/lib/hook-env.sh`). Hai file này là bản chung chép nguyên văn từ Leaderboard — sửa thì sửa đồng bộ mọi repo. Phần riêng của SAB (tìm `yarn` cạnh `node`) nằm ở `.husky/lib/yarn-path.sh`. Không bao giờ `--no-verify`.
  - Có hook rồi thì **đừng chạy test "kiểm tra lần cuối" ngay trước commit** — gấp đôi thời gian. Vẫn chạy test hẹp trong lúc code; đọc lỗi từ output của hook.
- **Test xanh không phải bằng chứng hành vi đúng** — test phải assert hợp đồng thật, không assert vào mock của chính nó.
- **Việc nặng là khe CPU độc quyền trên cả máy** (nhiều phiên Claude chạy chung): một lượt test/build tại một thời điểm; agent song song chỉ an toàn khi thuần đọc/sửa file. Sau khi chạy xong, dọn tiến trình jest/vitest mồ côi do chính mình tạo.
  - **Khoá máy dùng chung** (test, `docker build`, commit có hook chạy suite) — quy ước chung với các phiên JudgeHub/Leaderboard/ComparableTransaction:
    ```bash
    MYEPOCH=$(date +%s)   # re-queueing after an interrupted wait: reuse the old epoch to keep your place
    OWNER="SAB-Store <job> $MYEPOCH"; F=/tmp/cc-heavy.sab-wants; echo "$OWNER" > "$F"
    older_live() {  # yield ONLY to live (<5 min) flags of other repos with an OLDER epoch - yielding
                    # to every live flag deadlocks two waiters (observed 2026-09-29)
      local f e
      for f in /tmp/cc-heavy.*-wants; do
        [ -e "$f" ] && [ "$f" != "$F" ] || continue
        [ -n "$(find "$f" -mmin -5)" ] || continue
        e=$(awk '{print $3}' "$f" 2>/dev/null)
        [[ "$e" =~ ^[0-9]+$ ]] || return 0   # live but empty/unreadable counts as older: yield
        [ "$e" -lt "$MYEPOCH" ] && return 0
      done; return 1
    }
    mem_ok() { [ "$(memory_pressure -Q | awk -F': ' '/free percentage/ {print $2+0}')" -ge 35 ]; }
    until ! older_live && mem_ok && mkdir /tmp/cc-heavy.lock 2>/dev/null; do touch "$F"; sleep 30; done
    echo "$OWNER" > /tmp/cc-heavy.lock/owner; rm -f "$F"
    # ... job; before EVERY heavy step: grep -qxF "$OWNER" /tmp/cc-heavy.lock/owner ...
    grep -qxF "$OWNER" /tmp/cc-heavy.lock/owner && rm -rf /tmp/cc-heavy.lock
    ```
    - Cờ `*-wants` chỉ tồn tại khi đang ở trong vòng chờ; `touch` mỗi nhịp (heartbeat). Cờ có mtime > 5 phút là chết: bỏ qua, **không xoá** (chỉ chủ xoá). Khoá chỉ coi là stale sau 45 phút **và** sau khi đã nhắn chủ. Xếp hàng mà chưa chờ → nhắn tin, không dựng cờ.
    - Tôn trọng mọi cờ còn sống của repo khác; hoà nhau thì epoch cũ hơn đi trước. Quyền ưu tiên chỉ do **user** cấp, có giờ kết thúc, báo cho mọi phiên.
    - Bash tool không giữ biến giữa các lần gọi → ghi lại literal `$OWNER` để release.
    - "Nặng" = test, install, typecheck, build, dựng app/compose stack, lái trình duyệt. Dev server/stack nhàn rỗi phải dừng. Git hook tự lấy khoá thì shell đang giữ khoá phải `export CC_HEAVY_OWNER='<owner line>'` trong cùng lệnh `git commit`/`git push`. Đầy đủ: `mem:lessons/process/heavy_work_lock`.
  - **Cổng host**: tra/ghi `/tmp/cc-ports.registry` (`<port> <repo> <mục đích>`) trước khi publish cổng; chỉ sửa dòng của SAB-Store, xoá dòng khi dừng stack. Stack kiểm thử production-like của SAB-Store dùng `127.0.0.1:8088`.
  - Script chạy lệnh có mảng đối số: dùng `bash`, không dựa vào word-splitting của zsh (`$C args` trong zsh không tách từ).
- **Đừng chép số đo vào file này.**

### Soi comment TRƯỚC KHI commit (bắt buộc)

Đọc lại diff và **xoá**: work log ("bản trước dùng X"), diễn giải lại code, tham chiếu plan/phase/audit,
comment chết, TODO không chủ, đường dẫn tới thứ git không track (`plans/`, report cục bộ, path máy cá nhân).

**Giữ**: VÌ SAO chọn cách này (nhất là khi cách hiển nhiên lại sai), invariant và hậu quả nếu vi phạm,
cạm bẫy đã đo được kèm bằng chứng.

## 5. Git, nhánh, đồng bộ máy

- **Làm việc trên `dev`.** `main` là nhánh production — push lên `main` là Coolify deploy. Chỉ merge/push `main` khi user yêu cầu thẳng.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`…), mô tả hành vi/invariant. Không đưa plan ID, số phase, nhãn audit vào commit message, tên test hay comment.
- Stage file tường minh; không `git add .` / `git add --renormalize .` khi working tree còn thay đổi của user.
- **Syncthing**: working tree và `.git` đồng bộ giữa Mac và Windows; git config, reflog, index là **riêng từng máy** (luật ignore ở `.stignore-shared` của thư mục cha, ngoài repo — không bao giờ đặt `(?d)` lên `.git`). Chi tiết đã đo: `mem:lessons/sync/syncthing_shared_git`.
  - **Một người ghi git tại một thời điểm.** Máy A commit xong thì dừng; máy B chờ Syncthing "Up to Date", chạy `git reset` (index riêng từng máy), kiểm HEAD + status sạch rồi mới làm tiếp.
  - File text luôn LF (`.gitattributes`). Cả hai OS không phân biệt hoa thường → đổi hoa/thường tên file phải kiểm trong Docker (Linux).

## 6. Chạy agent

### Nhiều agent review TRƯỚC KHI commit (bắt buộc)

Trước **mỗi** commit có thay đổi code, chạy **ít nhất 2 agent review read-only, mỗi agent một góc
nhìn khác nhau** (3–4 khi diff chạm luồng tiền/tồn kho/auth). Góc nhìn cắt theo loại lỗi:

- **Hồi quy**: đường code cũ có đổi hành vi không; bắt buộc khi refactor được khai là "thuần".
- **Rò dữ liệu / zero-trust**: quyền admin/seller, dữ liệu khách hàng, credential trong export/log.
- **Toàn vẹn dữ liệu**: giá, tồn kho, trạng thái đơn, đua ghi đồng thời, chỗ hai nguồn số lệch nhau âm thầm.
- **Biên tập + chất lượng test**: comment thừa, DRY, test có chứng minh đúng điều nó khai không.

Luật vận hành: reviewer không được sửa code; orchestrator **tự thẩm định** phát hiện trước khi sửa;
mỗi phát hiện phải neo `file:line` + kịch bản hỏng có thật — bỏ ca "về lý thuyết".

### Xét theo TOÀN pipeline, không xét hàm đơn lẻ

Câu hỏi đúng: **"đầu vào xấu có tới được đây không, sau mọi cổng phía trước?"** — middleware
validation, kiểm quyền, schema Mongoose, index unique, nginx. Cổng trước đã chặn thì không phải
phát hiện và không thêm kiểm tra. Ngoại lệ được phép trùng lớp (phải ghi lý do): ranh giới tin cậy
đổi chủ, fail-closed cho tiền/tồn kho/quyền, invariant mà schema không giữ được.

### Giữ agent trong tầm kiểm soát

- Mọi lệnh Agent truyền `model: "sonnet"` tường minh; opus chỉ cho `kongming` (override khỏi fable) hoặc leo thang sau 3 vòng sonnet hỏng, tối đa một lúc: `mem:lessons/process/subagent_model_cap`.
- Không worktree. Agent chỉ sửa file chạy song song được khi sở hữu file tách rời (lint được, không test/typecheck); một verify agent chạy test sau cùng.

- Giao **danh sách file được sửa** tường minh; cần sửa ngoài danh sách thì báo orchestrator rồi dừng.
- Chỉ orchestrator chạy git ghi; agent implement chỉ git đọc.
- Orchestrator quyết định kỹ thuật; chỉ hỏi user khi chạm quyết định sản phẩm hoặc thứ khó đảo ngược (deploy, dữ liệu production).
- Agent báo lệch so với plan, không tự ứng biến kiến trúc. Không spawn agent git khi còn agent đang sửa file — chung một working tree.

### Nhịp cập nhật khi chạy nhiều agent

- **Xong MỖI agent → cập nhật plan ngay** (bước đã xong, chỗ lệch plan). Agent sau đọc plan để biết đang ở đâu; plan cũ = làm trùng hoặc sai giả định.
- **Xong MỖI wave → commit** (wave = nhóm agent chạy song song cùng đợt), khi cả wave xong và cây sạch, trước khi spawn wave kế. Dồn nhiều wave rồi commit một lần là mất điểm quay lui khi wave sau hỏng.

## 7. UX — nguyên tắc bắt buộc

1. **Trạng thái hệ thống luôn thấy được**: mọi thao tác async (submit, save, load) có spinner/skeleton/text "Đang …"; không để UI im lặng.
2. **Phản hồi ngay**: toast thành công/thất bại sau mỗi action (`react-toastify`); lỗi hiện message của server, không nuốt.
3. **Chặn submit hai lần**: nút submit/action `disabled` sau click tới khi có phản hồi — nhất là đặt hàng/thanh toán (đơn trùng = tiền/tồn kho lệch).
4. **Control cùng hàng cùng chiều cao**: toolbar, filter bar, hàng nút dùng cùng cỡ padding/size; container `items-center`; không hardcode `height` lệch nhau.
5. **Nội dung do admin soạn** (Markdown lời nhắc…) hiển thị qua đúng một renderer dùng chung, và màn soạn có preview bằng chính renderer đó.
