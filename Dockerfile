# syntax=docker/dockerfile:1
# One image for every target: single container, docker compose, AWS ECS (Fargate/EC2).
# Multi-arch: docker buildx build --platform linux/amd64,linux/arm64 .

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY . .
# Web app → web/dist; server TypeScript → server/dist (+ schema.sql next to db.js)
RUN pnpm --filter web build \
 && cd server && npx tsc -p . && cp src/schema.sql dist/ && rm -f dist/*.test.js \
 && cd .. && pnpm --filter server deploy --prod /out/server \
 && cp -r server/dist /out/server/dist

FROM node:24-slim
ENV NODE_ENV=production PORT=3100 UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY --from=build --chown=node:node /out/server /app/server
COPY --from=build --chown=node:node /app/web/dist /app/web/dist
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3100/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/server
CMD ["node", "dist/index.js"]
