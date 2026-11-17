#!/bin/sh
# Canonical runner: installation writes data, never shell source.
root=$(CDPATH= cd -- "${0%/*}/.." && pwd -P) || exit 0
action=${1-}
set --
while IFS= read -r argument; do
  [ "$#" -lt 16 ] && [ "${#argument}" -le 4096 ] || exit 0
  set -- "$@" "$argument"
done < "$root/.opencrawl-command"
[ "$#" -gt 0 ] || exit 0
case "$1" in /*) ;; *) exit 0 ;; esac
exec "$@" plugin-hook --root "$root" --action "$action"
