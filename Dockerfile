# syntax=docker/dockerfile:1
# Builds the two deployable images from one workspace build:
#   --target api  NestJS gateway API (long-running Node server)
#   --target web  admin SPA served by nginx, reverse-proxying the API paths
# No env files or secrets are copied in; configuration is supplied at runtime.

FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
RUN npm install -g bun@1.3.14
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
RUN bun install --frozen-lockfile
COPY apps ./apps
# The admin calls the API on its own origin (relative URLs), so no
# VITE_API_BASE_URL is baked into the bundle.
RUN cd apps/api && bun run build \
  && cd ../admin && bun run build

FROM base AS api
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api ./apps/api
WORKDIR /app/apps/api
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]

FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY deploy/gateway/web.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
