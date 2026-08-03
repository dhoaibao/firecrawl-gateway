# Stage 1: install all workspace dependencies and build the monorepo
FROM node:22.22.0-alpine AS builder

WORKDIR /app
COPY package*.json ./
COPY tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci

COPY apps/ apps/
COPY packages/ packages/
COPY turbo.json ./
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: runtime
FROM node:22.22.0-alpine

WORKDIR /app

RUN addgroup -g 1001 -S gateway && adduser -S gateway -u 1001

COPY --from=builder --chown=gateway:gateway /app/node_modules ./node_modules
COPY --from=builder --chown=gateway:gateway /app/package*.json ./
COPY --from=builder --chown=gateway:gateway /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder --chown=gateway:gateway /app/apps/api/dist/ ./apps/api/dist/
COPY --from=builder --chown=gateway:gateway /app/apps/api/prisma/ ./apps/api/prisma/
COPY --from=builder --chown=gateway:gateway /app/apps/api/scripts/migrate.cjs ./apps/api/scripts/migrate.cjs
COPY --from=builder --chown=gateway:gateway /app/apps/api/scripts/migration-preflight.cjs ./apps/api/scripts/migration-preflight.cjs
COPY --from=builder --chown=gateway:gateway /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder --chown=gateway:gateway /app/apps/web/dist/ ./apps/web/dist/
COPY --from=builder --chown=gateway:gateway /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=builder --chown=gateway:gateway /app/packages/contracts/dist/ ./packages/contracts/dist/

COPY --chown=root:root deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080
ARG BUILD_VERSION=unknown
LABEL org.opencontainers.image.revision="$BUILD_VERSION"
LABEL org.opencontainers.image.title="Firecrawl Gateway"
LABEL org.opencontainers.image.description="Hardened Firecrawl gateway API and worker image"

EXPOSE 8080

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["api"]
