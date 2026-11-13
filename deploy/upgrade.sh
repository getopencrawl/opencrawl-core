#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime_node=$("$root/dev/up" --node-runtime)
exec "$runtime_node" "$root/deploy/upgrade.mjs" "$@"
