# `@sab/shared` is consumed from its build: stale build = false green

- Source is ESM; esbuild emits ESM + CJS (`exports` import/require, `zod` external) because backend Jest cannot `require` ESM.
- `pretest`/`predev`/`prebuild` rebuild it; `**/dist` is dockerignored so images always build it from source. A direct `node server.js` / `npx jest` skips the rebuild.
- No `sideEffects:false`: `z.config` (Vietnamese `customError`, `jitless` for the `script-src 'self'` CSP) is a load-bearing side effect.
- Consumers never import `zod`; they import `z` from `@sab/shared` so one Zod instance carries the config.

**Why:** 05/10/2026 a message edited in shared source without rebuilding left backend tests green against the old text until `pretest` was added; CSP report-only logged Zod's `new Function` probe on every page until `jitless`.
**How to apply:** run tests and the app through the package scripts (`pnpm test`, `pnpm dev`, `pnpm build`); use `pnpm --filter @sab/shared build:watch` while editing shared during dev.
