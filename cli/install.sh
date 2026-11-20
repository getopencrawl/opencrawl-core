#!/bin/sh
# Native install with an optional interactive handoff after installation.
set -eu
handoff=
case "${1:-}" in
  --setup|--connect) handoff=$1; shift ;;
esac
if [ "$handoff" = --connect ] && [ "${1:-}" = --api ]; then
  export OPENCRAWL_API_URL="${2:?Missing workspace address after --api}"
  shift 2
fi
version=${1:-latest}
case "$version" in
  latest|next)
    epoch=$(($(date +%s) / 30))
    version=$(curl -fsSL --retry 3 "https://raw.githubusercontent.com/getopencrawl/opencrawl-core/cli-stable/release.json?epoch=$epoch" | sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p')
    ;;
esac
if ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo 'Usage: install.sh [--setup | --connect [--api URL]] [latest|VERSION]' >&2; exit 1
fi
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo 'Use install.ps1 on Windows.' >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo 'Unsupported CPU architecture.' >&2; exit 1 ;; esac
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then arch=arm64; fi
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then echo 'This release requires glibc; musl/Alpine is not supported.' >&2; exit 1; fi
archive="opencrawl-$os-$arch.tgz"
base=${OPENCRAWL_DOWNLOAD_BASE:-https://github.com/getopencrawl/opencrawl-core/releases/download/cli-v$version}
case "$base" in https://*|http://127.0.0.1:*|http://localhost:*) ;; *) echo 'Downloads require HTTPS.' >&2; exit 1 ;; esac
scratch=$(mktemp -d "${TMPDIR:-/tmp}/opencrawl-install.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
echo "Downloading OpenCrawl $version ($os-$arch)..."
curl -fsSL --retry 3 "$base/SHA256SUMS" -o "$scratch/SHA256SUMS"
curl -fsSL --retry 3 "$base/$archive" -o "$scratch/$archive"
expected=$(awk -v name="$archive" '$2 == name {print $1}' "$scratch/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$scratch/$archive" | awk '{print $1}'); else actual=$(shasum -a 256 "$scratch/$archive" | awk '{print $1}'); fi
if [ ${#expected} -ne 64 ] || [ "$actual" != "$expected" ]; then echo 'OpenCrawl download checksum mismatch.' >&2; exit 1; fi
tar -xzf "$scratch/$archive" -C "$scratch"
if [ ! -s "$scratch/package/bin/opencrawl" ]; then echo 'OpenCrawl archive has no executable.' >&2; exit 1; fi
chmod 755 "$scratch/package/bin/opencrawl"
"$scratch/package/bin/opencrawl" install

connect_agent() {
  if [ "$handoff" = --connect ] && [ "$os" = linux ]; then
    "$entry" login && "$entry" collect install
  else
    "$entry" setup
  fi
}

if [ -n "$handoff" ]; then
  entry="${OPENCRAWL_INSTALL_DIR:-$HOME/.local/bin}/opencrawl"
  if [ -t 0 ] && [ -t 2 ]; then
    connect_agent
  elif [ -t 2 ] && terminal=$(tty <&2) && [ -r "$terminal" ]; then
    # Bun needs the actual terminal device for keyboard input on macOS.
    connect_agent <"$terminal"
  else
    if [ "$handoff" = --connect ] && [ -n "${OPENCRAWL_API_URL:-}" ]; then
      printf 'Use --api %s on the following commands.\n' "$OPENCRAWL_API_URL"
    fi
    if [ "$handoff" = --connect ] && [ "$os" = linux ]; then
      echo 'Run opencrawl login and then opencrawl collect install in a terminal to continue.'
    else
      echo 'Run opencrawl setup in a terminal to continue.'
      echo 'For unattended OpenCrawl Cloud installation, follow https://getopencrawl.com/agents.md and use opencrawl signup --json on a blank profile.'
    fi
  fi
fi
