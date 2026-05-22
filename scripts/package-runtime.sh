#!/usr/bin/env bash
set -euo pipefail

RELEASE="${1:-$(git rev-parse --short HEAD)}"
OUT="${2:-/tmp/tac-shooter-runtime-${RELEASE}.tar.gz}"
ROOT="$(pwd)"
TMP="$(mktemp -d)"

cleanup() {
  rm -rf "${TMP}"
}
trap cleanup EXIT

if [ ! -f apps/server/dist/src/index.js ] || [ ! -f packages/shared/dist/index.js ] || [ ! -f apps/client/dist/index.html ]; then
  echo "Missing build outputs. Run npm run build before packaging." >&2
  exit 1
fi

mkdir -p \
  "${TMP}/apps/server" \
  "${TMP}/apps/client" \
  "${TMP}/packages/shared" \
  "${TMP}/maps" \
  "${TMP}/ops/systemd"

cp -R apps/server/dist "${TMP}/apps/server/dist"
cp -R apps/client/dist "${TMP}/apps/client/dist"
cp -R packages/shared/dist "${TMP}/packages/shared/dist"
cp -R maps/. "${TMP}/maps/"
cp ops/systemd/tac-shooter.service "${TMP}/ops/systemd/tac-shooter.service"

cat > "${TMP}/package.json" <<'JSON'
{
  "name": "tac-shooter-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node apps/server/dist/src/index.js"
  },
  "dependencies": {
    "@tac/shared": "file:packages/shared",
    "ws": "^8.18.2",
    "zod": "^3.25.32"
  }
}
JSON

cat > "${TMP}/packages/shared/package.json" <<'JSON'
{
  "name": "@tac/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
JSON

tar -czf "${OUT}" -C "${TMP}" .
echo "${OUT}"
