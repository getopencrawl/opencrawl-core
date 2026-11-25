#!/bin/sh
# Read the bundled S3 service and its named data volume before Compose creates it.
# Missing or unfamiliar Docker state leaves activation to the explicit migration.
set -eu
model=$("$@" config s3) || exit 0
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
[ -n "$volume" ] || exit 0
existing=$(docker volume ls --filter "name=^${volume}$" --format '{{.Name}}') || exit 0
if [ -z "$existing" ]; then printf 1; fi
