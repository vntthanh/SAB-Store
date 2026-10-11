# Workspace images: root context, per-Dockerfile ignore, `pnpm deploy` without `--legacy`

- Both images build with `context: .`; BuildKit uses `<Dockerfile>.dockerignore` over the root one, and a pattern without `**/` only matches at the context root (nested `backend/uploads`, `tests` leaked in).
- Backend image: `pnpm deploy --prod --config.inject-workspace-packages=true`. `--legacy` re-resolves peers; once backend depends on a workspace package, better-auth's optional react/react-dom peers land in the image anyway (unused at runtime; `auto-install-peers=false`, `overrides`, `ignoredOptionalDependencies` did not remove them).
- A root `.pnpmfile.cjs` `readPackage` hook that deletes `peerDependencies`/`peerDependenciesMeta` entries DOES keep optional peers out of `deploy --prod` (11/10: better-auth 1.7's `vitest` peer had shipped vitest+vite, image 316→373 MB; node_modules 238→171 MB after). It must be COPYed with the manifests in both Dockerfiles; the lockfile records `pnpmfileChecksum`. react/react-dom kept (frontend uses better-auth/react).
- `onlyBuiltDependencies` must live in `pnpm-workspace.yaml`; per-package settings are ignored in a workspace.

**Why:** measured 05/10/2026 by listing image files and diffing `.pnpm` entries old vs new image; a Coolify ARG/NODE_ENV injection simulation built the same file list.
**How to apply:** after any Dockerfile/ignore/dependency change, build both images and list `/app` (no tests, `*.md`, `Dockerfile*`, host uploads) and require every backend dependency inside the image before merging to `main`.
