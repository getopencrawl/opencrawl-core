#!/bin/sh
# Native install: no Node, npm, Bun installation, login or capture enrollment.
set -eu
version=${1:-next}
case "$version" in
  next) version=$(curl -fsSL --retry 3 https://registry.npmjs.org/@getopencrawl/cli/next | sed -nE 's/.*"version"[[:space:]]*:[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p') ;;
esac
if ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo 'Usage: install.sh [next|VERSION]' >&2; exit 1
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
