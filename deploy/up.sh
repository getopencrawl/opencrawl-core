#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")"
command -v docker >/dev/null 2>&1 || { echo "Install Docker with the Compose plugin first." >&2; exit 1; }
if [ ! -f .env ]; then
  secret() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }
  key() { dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\n'; }
  sed -e "s/^OPENCRAWL_AUTH_SECRET=$/OPENCRAWL_AUTH_SECRET=$(secret)/" \
      -e "s/^OPENCRAWL_ORGANIZATION_ID=$/OPENCRAWL_ORGANIZATION_ID=org_$(secret)/" \
      -e "s/^OPENCRAWL_SETUP_TOKEN=$/OPENCRAWL_SETUP_TOKEN=$(secret)/" \
      -e "s|^OPENCRAWL_CONNECTOR_KEY=$|OPENCRAWL_CONNECTOR_KEY=$(key)|" \
      -e "s/^OPENCRAWL_S3_ACCESS_KEY_ID=$/OPENCRAWL_S3_ACCESS_KEY_ID=opencrawl$(secret | cut -c1-12)/" \
      -e "s/^OPENCRAWL_S3_SECRET_ACCESS_KEY=$/OPENCRAWL_S3_SECRET_ACCESS_KEY=$(secret)/" \
      -e "s/^OPENCRAWL_TEMPORAL_PASSWORD=$/OPENCRAWL_TEMPORAL_PASSWORD=$(secret)/" .env.example > .env
  chmod 600 .env
  echo "Created deploy/.env with local secrets. Fill in your Airbyte and HTTPS settings, then run ./up.sh again."
  exit 0
fi
docker compose up -d --build --wait --wait-timeout 600 "$@"
echo "OpenCrawl is running at the OPENCRAWL_URL configured in deploy/.env."
# The bootstrap grant is consumed once. Keep this URL private.
docker compose exec -T app node -e "console.log('Private first-run setup link: '+process.env.OPENCRAWL_URL+'/auth/signup?setup='+encodeURIComponent(process.env.OPENCRAWL_SETUP_TOKEN))"
