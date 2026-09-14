FROM node:22-alpine

# SAB Lanyard Backend
WORKDIR /app

# Install curl for the healthcheck below
RUN apk add --no-cache curl

COPY package*.json yarn.lock ./

RUN yarn install --frozen-lockfile --production=true

COPY . .

# Uploads volume is bind-mounted from the host; make sure the non-root
# user below can write to it before dropping privileges.
RUN mkdir -p /app/uploads && chown -R node:node /app

USER node

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD curl -f http://localhost:5000/health || exit 1

CMD ["yarn", "start"]
