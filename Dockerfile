# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.20.0-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
RUN npm install --global pnpm@11.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=yanxing-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store --package-import-method=copy

FROM dependencies AS build
COPY . .
ARG REPORT_MAX_UPLOAD_BYTES=26214400
ENV NEXT_TELEMETRY_DISABLED=1 \
    YANXING_STANDALONE=1 \
    YANXING_NEXT_DIST_DIR=.next \
    REPORT_MAX_UPLOAD_BYTES=${REPORT_MAX_UPLOAD_BYTES}
RUN pnpm build:docker
RUN chmod -R a=rX /app/.docker-runtime \
    && chmod 0555 /app/.docker-runtime/scripts/docker-entrypoint.sh

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    YANXING_COMPILED_RUNTIME=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    YANXING_NEXT_DIST_DIR=.next \
    YANXING_DATABASE_PATH=/app/storage/yanxing.sqlite \
    YANXING_KNOWLEDGE_STORAGE_ROOT=/app/storage/knowledge
COPY --from=build --chown=root:root /app/.docker-runtime ./
RUN install -d -m 0700 -o node -g node /app/storage /app/.next/cache
USER node
EXPOSE 3000
ENTRYPOINT ["/bin/sh", "/app/scripts/docker-entrypoint.sh"]
CMD ["web"]
