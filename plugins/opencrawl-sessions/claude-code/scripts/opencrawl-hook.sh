#!/bin/sh
# Hands a native hook to the OpenCrawl CLI. The CLI owns sign-in, the saved
# recording choice and the server address; this plugin stores none of them.
# Without the CLI the skill and MCP server still work, so do nothing.
cli=$(command -v opencrawl 2>/dev/null) || cli=
if [ -z "$cli" ]; then
  for candidate in "$HOME/.local/bin/opencrawl" /opt/homebrew/bin/opencrawl /usr/local/bin/opencrawl; do
    if [ -x "$candidate" ]; then cli=$candidate; break; fi
  done
fi
[ -n "$cli" ] || exit 0
# Tells the CLI which installed plugin copy ran this hook.
OPENCRAWL_SESSIONS_PLUGIN_ROOT=$(CDPATH= cd -- "${0%/*}/.." && pwd -P) || exit 0
export OPENCRAWL_SESSIONS_PLUGIN_ROOT
# Hooks use the credentials setup saved, never a token from the session shell.
unset OPENCRAWL_TOKEN OPENCRAWL_SESSIONS_TOKEN OPENCRAWL_AUTH
exec "$cli" "$@"
