# Runtime image for the self-hosted stack in compose.yaml. Build context is the repository root.
FROM node:24.22.2-bookworm-slim
WORKDIR /opencrawl
COPY --chown=node:node package.json package-lock.json ./
# Full install: the Temporal worker uses the pinned optional peers from devDependencies.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web
# Named volumes copy this ownership on first mount (board SQLite store).
RUN mkdir -p /data && chown node:node /data
USER node
