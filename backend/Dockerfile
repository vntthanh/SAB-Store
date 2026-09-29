# Base image pinned by digest (multi-arch index) so a rebuild of the same commit
# gets the same toolchain; bump deliberately.
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

# ── deps: production dependencies only ──────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json yarn.lock ./
# `--production=true` is explicit on purpose: the deploy platform injects every
# environment variable (NODE_ENV included) as an ARG into every stage, so the
# install must not depend on what NODE_ENV happens to be at build time. The cache
# mount keeps the yarn cache across builds, so a retry after a flaky download
# resumes instead of starting over.
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
	yarn install --frozen-lockfile --production=true --non-interactive

# ── runner ───────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runner
# curl backs the compose healthchecks (compose.yml, prod.compose.yml, coolify.compose.yml).
RUN apk add --no-cache curl
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

# The uploads mount point must be writable by the non-root user below; a bind
# mount on the host keeps whatever ownership the host gives it.
RUN mkdir -p /app/uploads && chown node:node /app/uploads

USER node
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD curl -f http://localhost:5000/health || exit 1

# node directly (not `yarn start`): one process fewer between the container and
# the app, so SIGTERM from `docker stop` reaches Node instead of yarn.
CMD ["node", "start.js"]
