# Kalibra team server image.
#
#   docker run -d -p 4317:4317 -v kalibra-data:/data \
#     -e KALIBRA_PUBLIC_URL=https://kalibra.example.com ghcr.io/libreguild/kalibra:next
#
# Kalibra answers under /kalibra (UI https://kalibra.example.com/kalibra/, API …/kalibra/api/…).
# The first start prints a one-time link to create the administrator (docker logs <container>).
# Everything Kalibra stores lives in /data: back up that volume.

# ── Build: the web UI and the single-file CLI (engine, server and UI inlined) ─────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
COPY packages/sdk/package.json packages/sdk/
COPY packages/demo/package.json packages/demo/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @kalibra/web && npm run build -w kalibra

# ── Run: Node and one bundle, as an unprivileged user ─────────────────────────────────────────
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="Kalibra" \
      org.opencontainers.image.description="Local-first, open-source evaluation for AI applications (team server)" \
      org.opencontainers.image.source="https://github.com/LibreGuild/kalibra" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    KALIBRA_MODE=server \
    KALIBRA_DIR=/data \
    KALIBRA_MODELS_DIR=/data/models \
    KALIBRA_HOST=0.0.0.0 \
    KALIBRA_PORT=4317
WORKDIR /app
COPY --from=build /src/packages/cli/dist/ /app/
COPY --from=build /src/LICENSE /app/LICENSE
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node
VOLUME ["/data"]
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KALIBRA_PORT||4317)+'/kalibra/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/kalibra.mjs"]
CMD ["server"]
