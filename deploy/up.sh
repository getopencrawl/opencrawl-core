#!/bin/sh
# Installs or updates this OpenCrawl stack. Usage: ./deploy/up.sh [domain]
# Without a domain it runs at http://localhost:8092; with one, Caddy serves HTTPS for it.
set -eu
umask 077
cd "$(dirname "$0")"
command -v docker >/dev/null 2>&1 || { echo "Install Docker with the Compose plugin first: https://docs.docker.com/engine/install/" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Install the Docker Compose plugin first." >&2; exit 1; }
hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
setting() { sed -n "s/^$1=//p" .env | tail -n 1; }
if [ ! -f .env ]; then
  domain=${1:-}
  if [ -z "$domain" ] && [ -t 0 ]; then
    printf 'Domain for HTTPS (leave blank to run at http://localhost:8092): '
    read -r domain || domain=
  fi
  if [ -n "$domain" ]; then url="https://$domain"; profiles=https; else url=http://localhost:8092; profiles=; fi
  key=$(dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\n')
  sed -e "s|^OPENCRAWL_URL=$|OPENCRAWL_URL=$url|" \
      -e "s|^OPENCRAWL_DOMAIN=$|OPENCRAWL_DOMAIN=$domain|" \
      -e "s|^COMPOSE_PROFILES=$|COMPOSE_PROFILES=$profiles|" \
      -e "s|^OPENCRAWL_ORGANIZATION_ID=$|OPENCRAWL_ORGANIZATION_ID=org_$(hex 13)|" \
      -e "s|^OPENCRAWL_AUTH_SECRET=$|OPENCRAWL_AUTH_SECRET=$(hex 32)|" \
      -e "s|^OPENCRAWL_SETUP_TOKEN=$|OPENCRAWL_SETUP_TOKEN=$(hex 16)|" \
      -e "s|^OPENCRAWL_CONNECTOR_KEY=$|OPENCRAWL_CONNECTOR_KEY=$key|" \
      -e "s|^OPENCRAWL_S3_ACCESS_KEY_ID=$|OPENCRAWL_S3_ACCESS_KEY_ID=opencrawl$(hex 6)|" \
      -e "s|^OPENCRAWL_S3_SECRET_ACCESS_KEY=$|OPENCRAWL_S3_SECRET_ACCESS_KEY=$(hex 24)|" \
      -e "s|^OPENCRAWL_TEMPORAL_PASSWORD=$|OPENCRAWL_TEMPORAL_PASSWORD=$(hex 24)|" .env.example > .env
  chmod 600 .env
  echo "Created deploy/.env with generated secrets."
fi
# The worker starts connector containers through the host's Docker socket.
socket=$(setting OPENCRAWL_DOCKER_SOCKET); socket=${socket:-/var/run/docker.sock}
if [ -z "$(setting OPENCRAWL_DOCKER_GID)" ] && [ -S "$socket" ]; then
  gid=$(stat -c %g "$socket" 2>/dev/null || stat -f %g "$socket")
  sed -i.bak "s|^OPENCRAWL_DOCKER_GID=.*|OPENCRAWL_DOCKER_GID=$gid|" .env && rm -f .env.bak
fi
[ -z "$(setting GITHUB_APP)" ] || docker compose --profile build build source-github
docker compose up -d --build --wait --wait-timeout 900
url=$(setting OPENCRAWL_URL); token=$(setting OPENCRAWL_SETUP_TOKEN)
echo
echo "OpenCrawl is running at $url"
echo "First time? Create the admin account: $url/auth/signup${token:+?setup=$token}"
