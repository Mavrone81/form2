FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries; python3/make/g++ are the fallback
# if a prebuild is unavailable for this platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y python3 make g++ && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# The container listens on 3000 inside its own network namespace, always.
# Declared here so the app, the healthcheck and EXPOSE cannot drift apart —
# the host-facing default (30000) is a compose/.env concern, not the image's.
ENV PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY web ./web
# Fonts and the ICC profile the PDF generator loads at runtime.
COPY assets ./assets
# The database lives on a volume; the app must own the mount point.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT??3000)+'/api/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
