# Source sync runner for compose.yaml (sources-sync). Build context is the repository root.
# Airbyte's upstream declarative-manifest image (Airbyte CDK 7.45.1, MIT; run unmodified
# by the operator) executes the manifests; the Node runner in src/integrations drives it.
FROM node:24.22.2-bookworm-slim AS build
WORKDIR /opencrawl
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY tools ./tools
COPY tsconfig.json ./tsconfig.json
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM airbyte/source-declarative-manifest:7.45.1@sha256:f98cd95b4263c30c76b23c67b9c43e817e4f6b000663081e91778748b50d32e1
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=1000:1000 /opencrawl /opencrawl
COPY --chmod=0755 deploy/connectors/manifests /opencrawl/connectors/manifests
WORKDIR /opencrawl
ENV OPENCRAWL_SOURCES_MANIFESTS=/opencrawl/connectors/manifests
USER 1000
ENTRYPOINT []
CMD ["node", "dist/src/integrations/sync-standalone.mjs"]
