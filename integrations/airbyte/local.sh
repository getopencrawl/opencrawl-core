#!/usr/bin/env bash
# Run self-hosted Airbyte (via abctl) plus the OpenCrawl landing store on one machine.
#
#   ./local.sh up           install or start Airbyte and the landing store, write .env
#   ./local.sh status       show what is running
#   ./local.sh credentials  print the Airbyte UI login
#   ./local.sh down         stop the landing store and uninstall Airbyte, keeping data
#   ./local.sh destroy      remove Airbyte and landing data
#
# Settings (environment): AIRBYTE_PORT (8000), AIRBYTE_HOST (public hostname, optional),
# AIRBYTE_CHART_VERSION, ABCTL_VERSION, ABCTL_LOW_RESOURCE=1. Set DO_NOT_TRACK=1 to opt
# out of abctl's anonymous usage reporting.
set -euo pipefail

ABCTL_VERSION="${ABCTL_VERSION:-v0.30.4}"
AIRBYTE_CHART_VERSION="${AIRBYTE_CHART_VERSION:-2.4.0}"
AIRBYTE_PORT="${AIRBYTE_PORT:-8000}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/.env"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$HERE/landing/compose.yaml")

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

abctl_bin() {
  if command -v abctl >/dev/null && [[ "$(abctl version 2>/dev/null | awk '/version:/{print $2}')" == "$ABCTL_VERSION" ]]; then
    command -v abctl
    return
  fi
  local bin="$HOME/.local/bin/abctl"
  if [[ -x "$bin" && "$("$bin" version 2>/dev/null | awk '/version:/{print $2}')" == "$ABCTL_VERSION" ]]; then
    echo "$bin"
    return
  fi
  local os arch tmp name
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) die "unsupported architecture $(uname -m)" ;;
  esac
  name="abctl-${ABCTL_VERSION}-${os}-${arch}.tar.gz"
  tmp="$(mktemp -d)"
  log "Installing abctl $ABCTL_VERSION to $bin" >&2
  local base="https://github.com/airbytehq/abctl/releases/download/${ABCTL_VERSION}"
  curl -fsSL -o "$tmp/$name" "$base/$name"
  curl -fsSL -o "$tmp/checksums.txt" "$base/abctl_${ABCTL_VERSION#v}_checksums.txt"
  (cd "$tmp" && grep " $name\$" checksums.txt | sha256sum -c - >/dev/null) || die "abctl checksum mismatch"
  tar -xzf "$tmp/$name" -C "$tmp"
  mkdir -p "$(dirname "$bin")"
  install -m 0755 "$tmp/abctl-${ABCTL_VERSION}-${os}-${arch}/abctl" "$bin"
  rm -rf "$tmp"
  echo "$bin"
}

# Prints "Email/Password/Client-Id/Client-Secret: value" lines without ANSI colors.
credentials() {
  local out; out="$("$ABCTL" local credentials 2>&1)" || die "abctl local credentials failed: is Airbyte installed?"
  sed 's/\x1b\[[0-9;]*m//g' <<<"$out" | grep -E '^\s*(Email|Password|Client-Id|Client-Secret):' | sed 's/^ *//'
}

# Sets KEY=VALUE in .env, adding it if missing.
set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"
    rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

# Capture first: grep -q exiting early would fail the pipeline under pipefail.
installed() { local out; out="$("$ABCTL" local status 2>&1 || true)"; grep -q "Status: deployed" <<<"$out"; }

up() {
  command -v docker >/dev/null && docker info >/dev/null 2>&1 || die "Docker must be installed and running"
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$HERE/.env.example" "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"

  if installed; then
    log "Airbyte is already installed"
  else
    local args=(local install --no-browser --port "$AIRBYTE_PORT" --chart-version "$AIRBYTE_CHART_VERSION")
    [[ -n "${AIRBYTE_HOST:-}" ]] && args+=(--host "$AIRBYTE_HOST")
    if [[ "${ABCTL_LOW_RESOURCE:-}" == 1 ]] || (( $(getconf _NPROCESSORS_ONLN) < 4 )); then
      args+=(--low-resource-mode)
    fi
    log "Installing Airbyte chart $AIRBYTE_CHART_VERSION (first run takes 5-15 minutes)"
    "$ABCTL" "${args[@]}"
  fi

  local creds
  creds="$(credentials)"
  set_env AIRBYTE_URL "http://localhost:${AIRBYTE_PORT}"
  set_env AIRBYTE_CLIENT_ID "$(awk -F': *' '/^Client-Id/{print $2}' <<<"$creds")"
  set_env AIRBYTE_CLIENT_SECRET "$(awk -F': *' '/^Client-Secret/{print $2}' <<<"$creds")"
  if [[ -z "$(get_env OPENCRAWL_LANDING_PASSWORD)" ]]; then
    set_env OPENCRAWL_LANDING_PASSWORD "$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi

  if [[ -z "$(get_env OPENCRAWL_LANDING_S3_BUCKET)" ]]; then
    log "Starting the landing store"
    "${COMPOSE[@]}" up -d --wait
  fi

  log "Airbyte UI: http://localhost:${AIRBYTE_PORT} (login: ./local.sh credentials)"
  log "Connect a source: node integrations/airbyte/cli.mjs connect <source-type>"
}

status() {
  "$ABCTL" local status 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'Status|Version|Chart|not found|Kubernetes' || true
  [[ -f "$ENV_FILE" ]] && "${COMPOSE[@]}" ps 2>/dev/null || true
}

ABCTL="$(abctl_bin)"
case "${1:-}" in
  up) up ;;
  status) status ;;
  credentials) credentials ;;
  down)
    [[ -f "$ENV_FILE" ]] && "${COMPOSE[@]}" down || true
    "$ABCTL" local uninstall
    ;;
  destroy)
    read -r -p "Delete all Airbyte configuration and landing data? [y/N] " answer
    [[ "$answer" == [yY] ]] || exit 1
    [[ -f "$ENV_FILE" ]] && "${COMPOSE[@]}" down -v || true
    "$ABCTL" local uninstall --persisted
    rm -rf "$HOME/.airbyte/abctl"
    ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
