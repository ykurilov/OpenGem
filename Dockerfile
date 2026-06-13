FROM node:24-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3050 \
    HOST=0.0.0.0 \
    AUTH_BROWSER_CHROMIUM_PATH=/usr/bin/chromium

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 opengem \
    && useradd --system --uid 1001 --gid opengem opengem \
    && mkdir -p /app/data \
    && touch /app/config.json /app/.env \
    && chown -R opengem:opengem /app

COPY --from=builder --chown=opengem:opengem /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=opengem:opengem /app/node_modules ./node_modules
COPY --from=builder --chown=opengem:opengem /app/app.js ./app.js
COPY --from=builder --chown=opengem:opengem /app/dist ./dist
COPY --from=builder --chown=opengem:opengem /app/out ./out
COPY --from=builder --chown=opengem:opengem /app/public ./public

USER opengem
EXPOSE 3050

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3050/api/setup/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "app.js"]
