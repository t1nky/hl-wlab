#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v bun >/dev/null 2>&1; then
  echo 'Install Bun from https://bun.sh, then run this again.' >&2
  exit 1
fi
bun install --frozen-lockfile
bun run build
exec bun tools/serve-web.mjs "$@"
