# Suggested Commands — SAB-Store (macOS / zsh; Windows dùng Git Bash)

Package manager: **pnpm** (gốc, backend và frontend). Không `npm`/`yarn`.

## Backend (`cd backend`)
- `pnpm dev` — nodemon server
- `pnpm test <pattern>` — Jest, chạy hẹp (pattern truyền thẳng, không cần `--`)
- `pnpm test` — full suite (mongodb-memory-server replica set, tốn CPU)
- `node check-env.js` — kiểm env bắt buộc, không in giá trị
- `node scripts/audit-combo-pricing.js` (read-only), `node scripts/backfill-stock-deducted.js` (dry-run mặc định)

## Frontend (`cd frontend`)
- `pnpm dev` (Vite) · `pnpm build` · `pnpm test` (Vitest)

## Docker
- Dev: `docker compose up -d --build` (file `compose.yml`, env ở `.env` ROOT)
- Production chạy trên Coolify từ `coolify.compose.yml` — không deploy tay.
- `prod.compose.yml` + `docs/deployment.md`: đường rollback cho host không Coolify.

## Git
- Làm trên `dev`; `main` = production (Coolify deploy).
