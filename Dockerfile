# syntax=docker/dockerfile:1.7
#
# F.8 / DC-7: the container images for the whole system, built from one file.
#
#   app  the Bun runtime image. One image runs the API, the report worker, the
#        maintenance scheduler and the one-shot migration, chosen by command in
#        docker-compose.yml. Bun runs the TypeScript sources directly, so there
#        is no compile step.
#   web  the dashboard's static build behind nginx, which also proxies /api and
#        /ws to the API (deploy/nginx/wvs.conf).

ARG BUN_VERSION=1.3.14

# ---------------------------------------------------------------------------
# Dependencies. Manifests first, so a source-only change reuses this layer.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS install
# Prisma's engines link against OpenSSL, which the slim image leaves out.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/database/package.json packages/database/
COPY packages/scope-rules/package.json packages/scope-rules/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------
# Sources plus the generated Prisma client for this platform.
# ---------------------------------------------------------------------------
FROM install AS source
COPY . .
RUN bun run db:generate

# ---------------------------------------------------------------------------
# Dashboard build.
# ---------------------------------------------------------------------------
FROM source AS web-build
RUN bun run --filter @wvs/web build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY deploy/nginx/wvs.conf /etc/nginx/conf.d/default.conf
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080

# ---------------------------------------------------------------------------
# Runtime for the API, workers, scheduler and migrations.
# ---------------------------------------------------------------------------
FROM source AS app
ENV NODE_ENV=production
# Report files live on a volume shared by the API and the report worker
# (REPORT_STORAGE_PATH). Creating the directory here, owned by the runtime
# user, is what lets a fresh named volume start out writable.
RUN mkdir -p /app/storage/reports && chown -R bun:bun /app/storage
USER bun
EXPOSE 4100
CMD ["bun", "apps/api/src/main.ts"]
