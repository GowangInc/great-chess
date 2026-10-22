# Great Chess authoritative server image.
#
# Build context = repository root (package.json / package-lock.json are supplied
# by the repository owner). Only runtime files are copied; tests, the compose
# files and the database never enter the image.

FROM node:24-slim

ENV NODE_ENV=production \
    PORT=9277 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app

# Single runtime dependency (`ws`). Copied before the source so source edits do
# not invalidate the dependency layer.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Exactly the files the server may serve or import at runtime.
COPY server.js engine.js index.html app.js style.css pieces.js tutorial.js bot-worker.js config.js ./

# Persistent SQLite volume owned by the unprivileged runtime user.
RUN mkdir -p /data && chown node:node /data /app
VOLUME ["/data"]

USER node

EXPOSE 9277

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9277)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
