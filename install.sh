#!/bin/sh
# One-command OpenCrawl install on a machine with Docker:
#   curl -fsSL https://raw.githubusercontent.com/getopencrawl/opencrawl-core/main/install.sh | sh -s -- [domain]
# Leave out the domain to run at http://localhost:8092.
set -eu
if [ ! -f deploy/compose.yaml ]; then
  command -v git >/dev/null 2>&1 || { echo "Install git first." >&2; exit 1; }
  dir=${OPENCRAWL_DIRECTORY:-opencrawl}
  [ -d "$dir" ] || git clone --depth 1 --branch "${OPENCRAWL_REF:-main}" "${OPENCRAWL_REPOSITORY:-https://github.com/getopencrawl/opencrawl-core.git}" "$dir"
  cd "$dir"
fi
# Interactive prompts read from the terminal even when this script arrives on a pipe.
if [ ! -t 0 ] && [ $# -eq 0 ] && (true < /dev/tty) 2>/dev/null; then exec ./deploy/up.sh "$@" < /dev/tty; fi
exec ./deploy/up.sh "$@"
