#!/usr/bin/env bash
# Run the agent session receiver on one machine. Sessions land in your S3 bucket (see .env.example).
#
#   ./local.sh up                start the receiver; requires OPENCRAWL_LANDING_S3_BUCKET in .env
#   ./local.sh up --bundled-s3   also run a local S3 (SeaweedFS) and land there, for development
#   ./local.sh status            show what is running
#   ./local.sh logs              follow receiver logs
#   ./local.sh down              stop; captured sessions stay in S3
#   ./local.sh destroy           stop and delete the bundled S3's data (never touches your bucket)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/.env"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$HERE/compose.yaml")

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

set_env() {
  local key="$1" value="$2" tmp
  if grep -q "^${key}=" "$ENV_FILE"; then
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"
    rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
random() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

up() {
  command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "Docker must be installed and running"
  [[ -f "$ENV_FILE" ]] || cp "$HERE/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  if [[ "${1:-}" == --bundled-s3 ]]; then
    set_env COMPOSE_PROFILES bundled-s3
    set_env OPENCRAWL_LANDING_S3_ENDPOINT http://s3:8333
    [[ -n "$(get_env OPENCRAWL_LANDING_S3_BUCKET)" ]] || set_env OPENCRAWL_LANDING_S3_BUCKET opencrawl
    [[ -n "$(get_env OPENCRAWL_LANDING_S3_ACCESS_KEY_ID)" ]] || set_env OPENCRAWL_LANDING_S3_ACCESS_KEY_ID "opencrawl$(random 6)"
    [[ -n "$(get_env OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY)" ]] || set_env OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY "$(random 24)"
  fi
  [[ -n "$(get_env OPENCRAWL_LANDING_S3_BUCKET)" ]] || die "Set OPENCRAWL_LANDING_S3_BUCKET and its credentials in $ENV_FILE.
Or run './local.sh up --bundled-s3' to land in a local S3 for development."

  log "Starting the receiver"
  if ! "${COMPOSE[@]}" up -d --wait; then
    "${COMPOSE[@]}" logs --tail 5 receiver >&2
    die "The receiver did not start; see the log above."
  fi

  local port; port="$(get_env OPENCRAWL_SESSIONS_PORT)"
  log "Landing in $("${COMPOSE[@]}" logs receiver 2>/dev/null | grep -o 'landing in .*' | tail -1 | sed 's/^landing in //')"
  log "Receiver: http://127.0.0.1:${port:-7171}"
  if [[ "$(get_env COMPOSE_PROFILES)" == *bundled-s3* ]]; then
    log "Bundled S3 console: http://127.0.0.1:12535 (user admin, password OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY in .env)"
  fi
  log "Capture this machine's agent sessions: curl -fsSL http://127.0.0.1:${port:-7171}/install.sh | sh"
}

[[ -f "$ENV_FILE" || "${1:-}" == up ]] || die "Not set up yet; run ./local.sh up"
case "${1:-}" in
  up) up "${2:-}" ;;
  status) "${COMPOSE[@]}" ps ;;
  logs) "${COMPOSE[@]}" logs -f receiver ;;
  down) "${COMPOSE[@]}" down ;;
  destroy)
    read -r -p "Stop the receiver and delete the bundled S3's data? Your own bucket is not touched. [y/N] " answer
    [[ "$answer" == [yY] ]] || exit 1
    "${COMPOSE[@]}" down -v
    ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
