# Suggested Commands — SAB-Store (macOS / zsh; Windows dùng Git Bash)

Package manager: **pnpm** (gốc, backend và frontend). Không `npm`/`yarn`.

## Backend (`cd backend`)
- `pnpm dev` — nodemon server
- `pnpm test <pattern>` — Vitest, chạy hẹp (pattern là bộ lọc đường dẫn, truyền thẳng)
- `pnpm test` — full suite trên PostgreSQL (embedded-postgres, tốn CPU)
- `node scripts/merge-products-into-variants.js …` — gộp sản phẩm đứng thay từng giá trị (vd mỗi size một sản phẩm) thành một sản phẩm có phân loại; mặc định dry-run, `--apply` để ghi
- `node check-env.js` — kiểm env bắt buộc, không in giá trị
- `node scripts/audit-combo-pricing.js` (read-only)

## Frontend (`cd frontend`)
- `pnpm dev` (Vite) · `pnpm build` · `pnpm test` (Vitest)

## Docker
- Dev: `docker compose up -d --build` (file `compose.yml`, env ở `.env` ROOT)
- Production chạy trên Coolify từ `coolify.compose.yml` — không deploy tay.
- `prod.compose.yml` + `docs/deployment.md`: đường rollback cho host không Coolify.

## Git
- Làm trên `dev`; `main` = production (Coolify deploy).
