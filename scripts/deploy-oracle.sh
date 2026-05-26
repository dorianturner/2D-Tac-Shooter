#!/usr/bin/env bash
set -euo pipefail

RELEASE="${GITHUB_SHA:-$(git rev-parse --short HEAD)}"
APP_DIR="${APP_DIR:-/opt/tac-shooter}"
SERVICE_NAME="${SERVICE_NAME:-tac-shooter}"
ARCHIVE="/tmp/tac-shooter-${RELEASE}.tar.gz"
RELEASE_DIR="${APP_DIR}/releases/${RELEASE}"
NODE_VERSION="${NODE_VERSION:-22}"
APP_PORT="${APP_PORT:-8787}"

NODE_ARCH="$(uname -m)"
case "${NODE_ARCH}" in
  x86_64 | amd64)
    NODE_DIST_ARCH="x64"
    ;;
  aarch64 | arm64)
    NODE_DIST_ARCH="arm64"
    ;;
  *)
    echo "Unsupported Node architecture: ${NODE_ARCH}" >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1 || ! node --version | grep -q "^v${NODE_VERSION}\\."; then
  NODE_TARBALL="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_VERSION}.x/SHASUMS256.txt" | awk -v arch="linux-${NODE_DIST_ARCH}.tar.xz" '$2 ~ arch {print $2; exit}')"
  if [ -z "${NODE_TARBALL}" ]; then
    echo "Unable to determine latest Node ${NODE_VERSION}.x linux-${NODE_DIST_ARCH} tarball" >&2
    exit 1
  fi
  curl -fsSLo "/tmp/${NODE_TARBALL}" "https://nodejs.org/dist/latest-v${NODE_VERSION}.x/${NODE_TARBALL}"
  sudo rm -rf "/opt/node-v${NODE_VERSION}"
  sudo mkdir -p "/opt/node-v${NODE_VERSION}"
  sudo tar -xJf "/tmp/${NODE_TARBALL}" --strip-components=1 -C "/opt/node-v${NODE_VERSION}"
  sudo ln -sfn "/opt/node-v${NODE_VERSION}/bin/node" /usr/local/bin/node
  sudo ln -sfn "/opt/node-v${NODE_VERSION}/bin/npm" /usr/local/bin/npm
  sudo ln -sfn "/opt/node-v${NODE_VERSION}/bin/npx" /usr/local/bin/npx
fi

mkdir -p "${APP_DIR}/releases"
rm -rf "${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"
tar -xzf "${ARCHIVE}" -C "${RELEASE_DIR}"

cd "${RELEASE_DIR}"
npm install --omit=dev --no-audit --no-fund --ignore-scripts
if [ ! -f apps/client/dist/index.html ]; then
  echo "Missing apps/client/dist/index.html. Build before packaging the release." >&2
  exit 1
fi

sudo cp ops/systemd/tac-shooter.service "/etc/systemd/system/${SERVICE_NAME}.service"
if [ -f ops/caddy/Caddyfile ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    sudo dnf -y install dnf-plugins-core
    sudo dnf -y copr enable @caddy/caddy
    sudo dnf -y install caddy
  fi
  sudo mkdir -p /etc/caddy
  sudo cp ops/caddy/Caddyfile /etc/caddy/Caddyfile
  sudo firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  sudo firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
  sudo firewall-cmd --reload >/dev/null 2>&1 || true
  sudo systemctl enable caddy
fi
sudo rm -f /etc/nginx/conf.d/tac-shooter.conf
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"

ln -sfn "${RELEASE_DIR}" "${APP_DIR}/current"

sudo systemctl restart "${SERVICE_NAME}"
if command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
  sudo systemctl restart caddy
fi
for attempt in $(seq 1 20); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null; then
    sudo systemctl --no-pager --lines=40 status "${SERVICE_NAME}"
    exit 0
  fi
  sleep 1
done

sudo systemctl --no-pager --lines=120 status "${SERVICE_NAME}" || true
sudo journalctl -u "${SERVICE_NAME}" --no-pager -n 120 || true
exit 1
