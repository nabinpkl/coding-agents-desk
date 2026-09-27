# Built from agent-feed/ so the hub can read the shared wire types.
FROM oven/bun:1.3.13-slim
WORKDIR /app
COPY wire ./wire
COPY hub/package.json hub/bun.lock hub/tsconfig.json ./hub/
RUN cd hub && bun install --frozen-lockfile --production
COPY hub/src ./hub/src
WORKDIR /app/hub
USER bun
CMD ["bun", "src/main.ts"]
