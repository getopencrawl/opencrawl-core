#!/bin/sh
set -eu

# Read the bundled service before Compose allocates volumes. Any unknown or
# existing storage stays on the explicit migration path. Also called by dev/up.
fresh_credential_volume() {
  model=$(docker compose "$@" config s3) || return 0
  volume=$(printf '%s\n' "$model" | awk '
    /^name: [a-z0-9][a-z0-9_-]*$/ { project=$2 }
    /^services:$/ { services=1; next }
    /^[^ ]/ { services=0; volumes=($0=="volumes:"); resource=0; next }
    services && /^    image: chrislusf\/seaweedfs:/ { image=1 }
    services && /^    (entrypoint|build):/ { custom=1 }
    services && /^      - mini$/ { mini=1 }
    services && /^      - -dir=\/data$/ { dir=1 }
    services && /^      - -bucket=opencrawl$/ { bucket=1 }
    services && /^      - type: / { type=$3; source="" }
    services && /^        source: / { source=$2 }
    services && /^        target: \/data$/ { mount=(type=="volume" && source=="s3") }
    volumes && /^  [^ ]/ { resource=($0=="  s3:") }
    resource && /^    name: / { name=$2 }
    resource && /^    (external|driver|driver_opts):/ { custom=1 }
    END { if(project && name==project "_s3" && image && mini && dir && bucket && mount && !custom) print name }
  ')
  [ -n "$volume" ] || return 0
  existing=$(docker volume ls --filter "name=^${volume}$" --format '{{.Name}}') || return 0
  if [ -z "$existing" ]; then printf 1; fi
}
if [ "${1:-}" = --check-fresh-credential-volume ]; then
  shift
  fresh_credential_volume "$@"
  exit 0
fi

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
compose_build_flag=--build=false
if [ "$compose_build" = true ]; then
  source_revision=$(git -C .. rev-parse HEAD)
  docker compose build --build-arg "OPENCRAWL_SOURCE_REVISION=$source_revision" app
  compose_build_flag=--no-build
elif [ "$compose_no_build" = true ]; then
  compose_build_flag=--no-build
fi
OPENCRAWL_BUNDLED_CREDENTIAL_VOLUME_NEW=$(fresh_credential_volume)
export OPENCRAWL_BUNDLED_CREDENTIAL_VOLUME_NEW
docker compose up -d "$compose_build_flag" --wait --wait-timeout 600 "$@"
echo "OpenCrawl is running at the OPENCRAWL_URL configured in deploy/.env."
# The bootstrap grant is consumed once. Keep this URL private.
docker compose exec -T app node -e "console.log('Private first-run setup link: '+process.env.OPENCRAWL_URL+'/auth/signup?setup='+encodeURIComponent(process.env.OPENCRAWL_SETUP_TOKEN))"
