# Server image. Node 24 runs the TypeScript sources directly (type stripping),
# so there is no build step. Build context is the repo root.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY shared ./shared
COPY server/src ./server/src

# The named volume mounted at /data inherits this ownership on first use.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3847
CMD ["node", "server/src/main.ts"]
