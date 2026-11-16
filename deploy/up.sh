#!/bin/sh
set -eu
umask 077
sqlite=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --sqlite) sqlite=true; shift ;;
    --no-airbyte) export OPENCRAWL_AIRBYTE_ENABLED=false; shift ;;
    --help|-h)
      echo 'Usage: ./deploy/up.sh [--sqlite] [--no-airbyte] [Compose up arguments...]'
      echo 'Use --sqlite on the first run for SQLite FTS5. The choice is saved in deploy/.env.'
      exit 0 ;;
    *) break ;;
  esac
done
cd "$(dirname "$0")"
sqlite_files=compose.yaml:compose.sqlite.yaml
if [ "$sqlite" = true ]; then
  if [ -n "${COMPOSE_FILE:-}" ] && [ "$COMPOSE_FILE" != "$sqlite_files" ]; then
    echo '--sqlite conflicts with the supplied COMPOSE_FILE.' >&2
    exit 1
  fi
  if [ -f .env ] && ! grep -Fxq "COMPOSE_FILE=$sqlite_files" .env; then
    echo 'Use --sqlite when creating a fresh installation. Existing deploy/.env uses another profile; changing its index requires a migration. See docs/search-backends.md. Existing data is preserved.' >&2
    exit 1
  fi
fi
command -v docker >/dev/null 2>&1 || { echo "Install Docker with the Compose plugin first." >&2; exit 1; }
secret() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }
if [ ! -f .env ]; then
  key() { dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr -d '\n'; }
  sed -e "s/^OPENCRAWL_AUTH_SECRET=$/OPENCRAWL_AUTH_SECRET=$(secret)/" \
      -e "s/^OPENCRAWL_ORGANIZATION_ID=$/OPENCRAWL_ORGANIZATION_ID=org_$(secret)/" \
      -e "s/^OPENCRAWL_SETUP_TOKEN=$/OPENCRAWL_SETUP_TOKEN=$(secret)/" \
      -e "s|^OPENCRAWL_CONNECTOR_KEY=$|OPENCRAWL_CONNECTOR_KEY=$(key)|" \
      -e "s/^OPENCRAWL_S3_ACCESS_KEY_ID=$/OPENCRAWL_S3_ACCESS_KEY_ID=opencrawl$(secret | cut -c1-12)/" \
      -e "s/^OPENCRAWL_S3_SECRET_ACCESS_KEY=$/OPENCRAWL_S3_SECRET_ACCESS_KEY=$(secret)/" \
      -e "s/^OPENCRAWL_DATABASE_PASSWORD=$/OPENCRAWL_DATABASE_PASSWORD=$(secret)/" \
      -e "s/^OPENCRAWL_TEMPORAL_PASSWORD=$/OPENCRAWL_TEMPORAL_PASSWORD=$(secret)/" .env.example > .env
  if [ "$sqlite" = true ]; then printf '\nCOMPOSE_FILE=%s\n' "$sqlite_files" >> .env; fi
  chmod 600 .env
  echo "Created deploy/.env with local secrets. Set OPENCRAWL_URL, configure Airbyte if enabled, then rerun this command."
  exit 0
fi
# Runtime services share one image tag. Build it once instead of asking parallel
# Compose targets to export the same tag into the containerd image store.
# Preserve Compose's explicit booleans and every other argument, including --.
compose_build=true
compose_build_explicit=false
compose_no_build=false
compose_literal=false
compose_args_remaining=$#
while [ "$compose_args_remaining" -gt 0 ]; do
  compose_arg=$1; shift
  compose_args_remaining=$((compose_args_remaining - 1))
  if [ "$compose_literal" = true ]; then set -- "$@" "$compose_arg"; continue; fi
  case "$compose_arg" in
    --) compose_literal=true; set -- "$@" "$compose_arg"; continue ;;
    --build|--no-build) compose_value=true ;;
    --build=*|--no-build=*) compose_value=${compose_arg#*=} ;;
    *) set -- "$@" "$compose_arg"; continue ;;
  esac
  case "$compose_value" in
    true|1|t|T|TRUE|True) compose_value=true ;;
    false|0|f|F|FALSE|False) compose_value=false ;;
    *) echo "Invalid boolean for $compose_arg" >&2; exit 1 ;;
  esac
  case "$compose_arg" in
    --build|--build=*) compose_build=$compose_value; compose_build_explicit=true ;;
    *) compose_no_build=$compose_value ;;
  esac
done
if [ "$compose_no_build" = true ]; then
  if [ "$compose_build_explicit" = true ] && [ "$compose_build" = true ]; then
    echo '--build and --no-build are incompatible' >&2; exit 1
  fi
  compose_build=false
fi
runtime_node=$(../dev/up --node-runtime)
# Retain an explicitly selected disabled integration mode across later upgrades.
# Persist only after the upgrader has captured the original configuration.
"$runtime_node" upgrade.mjs --automatic
compose_build_flag=--build=false
if [ "$compose_build" = true ]; then
  source_revision=$(git -C .. rev-parse HEAD)
  docker compose build --build-arg "OPENCRAWL_SOURCE_REVISION=$source_revision" app
  compose_build_flag=--no-build
elif [ "$compose_no_build" = true ]; then
  compose_build_flag=--no-build
fi
docker compose up -d "$compose_build_flag" --wait --wait-timeout 600 "$@"
"$runtime_node" upgrade.mjs --record-startup
echo "OpenCrawl is running at the OPENCRAWL_URL configured in deploy/.env."
# The bootstrap grant is consumed once. Keep this URL private.
docker compose exec -T app node -e "console.log('Private first-run setup link: '+process.env.OPENCRAWL_URL+'/auth/signup?setup='+encodeURIComponent(process.env.OPENCRAWL_SETUP_TOKEN))"
