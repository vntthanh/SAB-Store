# Base images pinned by digest (multi-arch index) so a rebuild of the same commit
# gets the same toolchain; bump deliberately.
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ARG NGINX_IMAGE=nginx:alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2

# ── deps ─────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
# The version must match `packageManager` in package.json.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
# The build context is the repository root (the workspace lockfile lives there).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY frontend/package.json ./frontend/
# `--prod=false` is load-bearing. The deploy platform injects every environment
# variable as an ARG into every stage, NODE_ENV=production included; a package
# manager that honours NODE_ENV then skips devDependencies and the build dies
# with `vite: not found`. The flag makes the install ignore NODE_ENV.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
	pnpm install --frozen-lockfile --prod=false --filter minipreorder-frontend...

# ── builder ──────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY frontend ./frontend
WORKDIR /app/frontend
# No VITE_API_URL: the SPA calls the API via the relative path /api, so nothing
# domain-specific gets baked into the bundle.
RUN pnpm build

# ── runner: static files behind nginx ────────────────────────────────────────
FROM ${NGINX_IMAGE} AS runner
# curl backs the compose healthchecks (compose.yml, prod.compose.yml, coolify.compose.yml).
RUN apk add --no-cache curl
COPY --from=builder /app/frontend/build /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/security-headers.conf /etc/nginx/security-headers.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD curl -f http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
