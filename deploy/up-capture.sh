#!/bin/sh
# Starts the self-hosted stack. Creates deploy/.env with random secrets on first run.
set -eu
umask 077
cd "$(dirname "$0")"
command -v docker >/dev/null 2>&1 || { echo "Docker is required: https://docs.docker.com/get-docker/" >&2; exit 1; }
if [ ! -f .env ]; then
  secret() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }
  sed -e "s/^OPENCRAWL_SESSIONS_TOKEN=$/OPENCRAWL_SESSIONS_TOKEN=$(secret)/" \
      -e "s/^MCP_TOKEN=$/MCP_TOKEN=$(secret)/" \
      -e "s/^OPENCRAWL_S3_ACCESS_KEY_ID=$/OPENCRAWL_S3_ACCESS_KEY_ID=opencrawl$(secret | cut -c1-12)/" \
      -e "s/^OPENCRAWL_S3_SECRET_ACCESS_KEY=$/OPENCRAWL_S3_SECRET_ACCESS_KEY=$(secret)/" \
      .env.capture.example > .env
  chmod 600 .env
  echo "==> Wrote deploy/.env with fresh secrets"
fi
docker compose -f compose.capture.yaml up -d --build --wait --wait-timeout 240 "$@"
. ./.env
cat <<MSG
==> OpenCrawl is running
    Session receiver  http://127.0.0.1:${OPENCRAWL_SESSIONS_PORT}
    MCP               http://127.0.0.1:${OPENCRAWL_MCP_PORT}/mcp  (Authorization: Bearer \$MCP_TOKEN)
    Temporal UI       http://127.0.0.1:8233
    Tokens            deploy/.env
MSG
