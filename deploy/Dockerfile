# Runtime image for the self-hosted stack in compose.yaml. Build context is the repository root.
FROM node:24.22.2-bookworm-slim
WORKDIR /opencrawl
COPY --chown=node:node package.json package-lock.json ./
# Full install: the Temporal worker uses the pinned optional peers from devDependencies.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node tools ./tools
COPY --chown=node:node tsconfig.json ./tsconfig.json
RUN npm run build
COPY --chown=node:node web ./web
COPY --chown=node:node web-v2/package.json web-v2/package-lock.json ./web-v2/
RUN npm ci --prefix web-v2 --ignore-scripts --no-audit --no-fund
COPY --chown=node:node web-v2/src ./web-v2/src
COPY --chown=node:node web-v2/tools ./web-v2/tools
COPY --chown=node:node web-v2/tsconfig.json ./web-v2/tsconfig.json
RUN npm run build --prefix web-v2
COPY --chown=node:node connectors ./connectors
COPY --chown=node:node deploy/*.mjs ./deploy/
COPY --chown=node:node LICENSE ./LICENSE
# Named volumes copy this ownership on first mount (board SQLite store).
RUN mkdir -p /data && chown node:node /data
USER node
