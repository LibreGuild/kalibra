# Kalibra team server image.
#
#   docker run -d -p 4317:4317 -v kalibra-data:/data \
#     -e KALIBRA_PUBLIC_URL=https://kalibra.example.com ghcr.io/libreguild/kalibra:next
#
# Kalibra answers under /kalibra (UI https://kalibra.example.com/kalibra/, API …/kalibra/api/…).
# The first start prints a one-time link to create the administrator (docker logs <container>).
# Everything Kalibra stores lives in /data: back up that volume.
#
# The runtime is Google's distroless Node.js image: Node, glibc, CA certificates and time zones,
# nothing else (no shell, no package manager), as user 1000. Node is /nodejs/bin/node (`docker exec … /nodejs/bin/node -e …`).
# The free local embedding model (meaning-based checks, duplicate search) is built in, so nothing
# is downloaded or installed at run time. `--build-arg LOCAL_EMBEDDINGS=0` leaves it out (~70 MB
# smaller); connections' embedding models still work.

# Base images are pinned by digest (multi-arch indexes); Dependabot proposes updates.

# ── Build: the web UI and the single-file CLI (engine, server and UI inlined) ─────────────────
# Platform-independent JavaScript, so it is built once on the build machine, not per platform.
FROM --platform=$BUILDPLATFORM node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS build
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
RUN npm run build -w @kalibra/web && npm run build -w kalibra \
 && mkdir -p /out/data /out/backups && chown 1000:1000 /out/data /out/backups

# ── Local embedding model, for the target platform (its ONNX runtime is native code) ───────────
# Same files, versions and ready-markers as the in-app download (packages/core/src/providers/
# embeddings.ts); the check at the end asks the built Kalibra itself whether the model is ready.
FROM node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS models
ARG LOCAL_EMBEDDINGS=1
ENV KALIBRA_MODELS_DIR=/opt/kalibra/models
COPY --from=build /src/packages/core/src/providers/embeddings.ts /tmp/embeddings.ts
COPY --from=build /src/packages/cli/dist/ /app/
RUN set -eu; mkdir -p "$KALIBRA_MODELS_DIR"; \
  if [ "$LOCAL_EMBEDDINGS" != "1" ]; then exit 0; fi; \
  version=$(grep -oP "TRANSFORMERS_VERSION = '\K[^']+" /tmp/embeddings.ts); \
  model=$(grep -oP "KALIBRA_LOCAL_EMBED_MODEL \|\| '\K[^']+" /tmp/embeddings.ts); \
  rt="$KALIBRA_MODELS_DIR/runtime"; hub="$KALIBRA_MODELS_DIR/hub"; mkdir -p "$rt" "$hub"; \
  printf '{"name":"kalibra-local-models","private":true,"dependencies":{"@huggingface/transformers":"%s"},"overrides":{"sharp":"npm:noop-package@1.0.0","onnxruntime-web":"npm:noop-package@1.0.0"}}' "$version" > "$rt/package.json"; \
  # CPU only: onnxruntime-node would otherwise also fetch ~200 MB of CUDA libraries on linux/x64.
  (cd "$rt" && ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm_config_onnxruntime_node_install_cuda=skip \
     npm install --omit=optional --no-audit --no-fund --loglevel=error); \
  find "$rt/node_modules" -name '*providers_cuda*' -o -name '*providers_tensorrt*' | xargs -r rm -f; \
  MODEL="$model" RT="$rt" HUB="$hub" node -e " \
    const fs = require('fs'), path = require('path'); \
    const bin = path.join(process.env.RT, 'node_modules/onnxruntime-node/bin'); \
    for (const napi of fs.readdirSync(bin)) for (const platform of fs.readdirSync(path.join(bin, napi))) \
      for (const arch of fs.readdirSync(path.join(bin, napi, platform))) \
        if (platform !== process.platform || arch !== process.arch) fs.rmSync(path.join(bin, napi, platform, arch), { recursive: true, force: true }); \
    const tf = require('module').createRequire(path.join(process.env.RT, 'package.json'))('@huggingface/transformers'); \
    tf.env.cacheDir = process.env.HUB; tf.env.allowRemoteModels = true; \
    tf.pipeline('feature-extraction', process.env.MODEL, { dtype: 'q8' }) \
      .then((fe) => fe(['hello'], { pooling: 'mean', normalize: true })) \
      .then((out) => console.log('local embedding model ready:', process.env.MODEL, out.dims.join('x'))); \
  "; \
  printf '%s' "$version" > "$rt/.kalibra-ready"; \
  printf '%s' "$model" > "$hub/.kalibra-ready-$(printf '%s' "$model" | sed 's/[^A-Za-z0-9_.-]\{1,\}/_/g')"; \
  rm -rf /root/.npm "$rt/package-lock.json"; du -sh "$KALIBRA_MODELS_DIR" "$rt/node_modules"/* | sort -h | tail -6; \
  node /app/kalibra.mjs op embeddings_status --dir /tmp/check | grep -q '"local": "ready"' \
    || { echo 'Kalibra does not see the built-in embedding model as ready' >&2; exit 1; }; \
  rm -rf /tmp/check

# ── Run: Node and one bundle, as an unprivileged user ─────────────────────────────────────────
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c
LABEL org.opencontainers.image.title="Kalibra" \
      org.opencontainers.image.description="Local-first, open-source evaluation for AI applications (team server)" \
      org.opencontainers.image.source="https://github.com/LibreGuild/kalibra" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="gcr.io/distroless/nodejs22-debian13:nonroot"
ENV NODE_ENV=production \
    HOME=/data \
    KALIBRA_MODE=server \
    KALIBRA_DIR=/data \
    KALIBRA_MODELS_DIR=/opt/kalibra/models \
    KALIBRA_HOST=0.0.0.0 \
    KALIBRA_PORT=4317
WORKDIR /app
COPY --from=build /src/packages/cli/dist/ /app/
COPY --from=build /src/LICENSE /app/LICENSE
COPY --from=models /opt/kalibra/models /opt/kalibra/models
# uid 1000, like earlier images (node:*-slim's "node" user), so existing /data volumes stay writable.
COPY --from=build --chown=1000:1000 /out/data /data
COPY --from=build --chown=1000:1000 /out/backups /backups
USER 1000:1000
VOLUME ["/data"]
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.KALIBRA_PORT||4317)+'/kalibra/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node", "/app/kalibra.mjs"]
CMD ["server"]
