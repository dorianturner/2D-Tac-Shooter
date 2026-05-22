#!/usr/bin/env bash
set -euo pipefail

RELEASE="${GITHUB_SHA:-$(git rev-parse --short HEAD)}"
APP_DIR="${APP_DIR:-/opt/tac-shooter}"
SERVICE_NAME="${SERVICE_NAME:-tac-shooter}"
ARCHIVE="/tmp/tac-shooter-${RELEASE}.tar.gz"
RELEASE_DIR="${APP_DIR}/releases/${RELEASE}"

mkdir -p "${APP_DIR}/releases"
rm -rf "${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"
tar -xzf "${ARCHIVE}" -C "${RELEASE_DIR}"

cd "${RELEASE_DIR}"
npm ci
npm run build --workspace @tac/shared
npm run build --workspace @tac/server

sudo cp ops/systemd/tac-shooter.service "/etc/systemd/system/${SERVICE_NAME}.service"
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
ln -sfn "${RELEASE_DIR}" "${APP_DIR}/current"

sudo systemctl restart "${SERVICE_NAME}"
sudo systemctl --no-pager --lines=80 status "${SERVICE_NAME}"
