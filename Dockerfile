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
    REPORT_MAX_UPLOAD_BYTES=${REPORT_MAX_UPLOAD_BYTES}
RUN pnpm build && node scripts/docker-runtime-config.mjs --write-build-config

FROM dependencies AS production-dependencies
RUN CI=true pnpm prune --prod

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    YANXING_NEXT_DIST_DIR=.next \
    TSX_TSCONFIG_PATH=/app/tsconfig.json \
    YANXING_DATABASE_PATH=/app/storage/yanxing.sqlite \
    YANXING_KNOWLEDGE_STORAGE_ROOT=/app/storage/knowledge
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/lib ./lib
COPY --from=build /app/modules ./modules
COPY --from=build /app/worker ./worker
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/LICENSE /app/package.json /app/tsconfig.json /app/tsconfig.source.json /app/next.config.mjs /app/.docker-build.json ./
RUN chmod -R a+rX /app \
    && install -d -m 0700 -o node -g node /app/storage \
    && chmod 0555 /app/scripts/docker-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["/bin/sh", "/app/scripts/docker-entrypoint.sh"]
CMD ["web"]
