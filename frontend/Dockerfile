# Base images pinned by digest (multi-arch index) so a rebuild of the same commit
# gets the same toolchain; bump deliberately.
ARG NODE_IMAGE=node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ARG NGINX_IMAGE=nginx:alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2

# ── deps ─────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json yarn.lock ./
# `--production=false` is load-bearing. The deploy platform injects every
# environment variable as an ARG into every stage, NODE_ENV=production included;
# yarn classic then silently skips devDependencies and the build dies with
# `vite: not found` (reproduced 2026-09-29 with `ARG NODE_ENV` +
# `--build-arg NODE_ENV=production`). The flag makes the install ignore NODE_ENV.
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
	yarn install --frozen-lockfile --production=false --non-interactive

# ── builder ──────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .
# No VITE_API_URL: the SPA calls the API via the relative path /api, so nothing
# domain-specific gets baked into the bundle.
RUN yarn build

# ── runner: static files behind nginx ────────────────────────────────────────
FROM ${NGINX_IMAGE} AS runner
# curl backs the compose healthchecks (compose.yml, prod.compose.yml, coolify.compose.yml).
RUN apk add --no-cache curl
COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD curl -f http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
