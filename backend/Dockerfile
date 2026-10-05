# Base image pinned by digest (multi-arch index) so a rebuild of the same commit
# gets the same toolchain; bump deliberately.
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# ── deploy: production dependencies of the backend package only ─────────────
FROM ${NODE_IMAGE} AS deploy
# The version must match `packageManager` in package.json.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
# The build context is the repository root (the workspace lockfile lives there);
# only manifests are copied, so a source edit does not invalidate the install.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY backend/package.json ./backend/
# `pnpm deploy` and not `pnpm install` + `pnpm prune --prod`: prune does not
# support a workspace and silently drops packages only one member uses.
# Without `--legacy` deploy installs exactly what pnpm-lock.yaml records for this
# package; `--legacy` re-resolves peers and pulled react/react-dom into the image
# (optional peers of better-auth that the lockfile does not install for the
# backend). pnpm only runs this mode with `inject-workspace-packages` on, so it is
# passed to this one command rather than set for every install.
# `--prod` is explicit on purpose: the deploy platform injects every environment
# variable (NODE_ENV included) as an ARG into every stage, so the install must not
# depend on what NODE_ENV happens to be at build time. The cache mount keeps the
# pnpm store across builds, so a retry after a flaky download resumes instead of
# starting over.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
	CI=true pnpm --filter minipreorder-backend --config.inject-workspace-packages=true \
	deploy --prod /out/backend

# ── runner ───────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runner
# curl backs the compose healthchecks (compose.yml, prod.compose.yml, coolify.compose.yml).
RUN apk add --no-cache curl
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deploy --chown=node:node /out/backend/node_modules ./node_modules
COPY --chown=node:node backend ./

# The uploads mount point must be writable by the non-root user below; a bind
# mount on the host keeps whatever ownership the host gives it.
RUN mkdir -p /app/uploads && chown node:node /app/uploads

USER node
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD curl -f http://localhost:5000/health || exit 1

# node directly (not `pnpm start`): one process fewer between the container and
# the app, so SIGTERM from `docker stop` reaches Node instead of pnpm.
CMD ["node", "start.js"]
