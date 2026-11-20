# Runtime image for the self-hosted stack in compose.yaml. Build context is the repository root.
FROM node:24.22.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
ARG REVISION=development
ENV REVISION=$REVISION
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
COPY --chown=node:node deploy/database-init.mjs deploy/wait-storage.mjs deploy/application-state-init.mjs ./deploy/
COPY --chown=node:node LICENSE ./LICENSE
# Named volumes copy this ownership on first mount (search index and retained migration sources).
RUN mkdir -p /data && chown node:node /data
ARG OPENCRAWL_SOURCE_REVISION=development
LABEL org.opencontainers.image.revision=$OPENCRAWL_SOURCE_REVISION
USER node
