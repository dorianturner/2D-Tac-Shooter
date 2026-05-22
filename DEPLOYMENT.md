# Deployment

This project deploys as two services:

- Vercel hosts the static Vite/Phaser client from `apps/client`.
- Oracle runs the authoritative Node/WebSocket server on `opc@193.123.190.8`.

The production client is HTTPS, so the game server must also be reachable over HTTPS/WSS. Do not point Vercel at `http://193.123.190.8:8787` for production; browsers will block that mixed-content request.

## Required DNS

Create a DNS record for the API server:

```text
api.your-domain.example  A  193.123.190.8
```

Use that host in Vercel environment variables:

```text
VITE_API_BASE_URL=https://api.your-domain.example/api
VITE_WS_URL=wss://api.your-domain.example
```

## Oracle First-Time Setup

SSH to the Oracle box:

```sh
ssh opc@193.123.190.8
```

Install Node 22, nginx, and certbot:

```sh
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs nginx certbot python3-certbot-nginx
node --version
npm --version
```

Open firewall ports on the VM and in the Oracle Cloud security list/network security group:

```sh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

Install the nginx reverse proxy config from your local checkout:

```sh
scp ops/nginx/tac-shooter-api.conf opc@193.123.190.8:/tmp/tac-shooter-api.conf
ssh opc@193.123.190.8
sudo cp /tmp/tac-shooter-api.conf /etc/nginx/conf.d/tac-shooter-api.conf
sudo sed -i 's/api.example.com/api.your-domain.example/g' /etc/nginx/conf.d/tac-shooter-api.conf
sudo nginx -t
sudo systemctl enable --now nginx
```

Issue TLS:

```sh
sudo certbot --nginx -d api.your-domain.example
```

The GitHub deploy workflow installs/updates the `tac-shooter` systemd unit automatically from `ops/systemd/tac-shooter.service`.

## GitHub Secrets

Add these repository secrets:

```text
VERCEL_TOKEN
VERCEL_ORG_ID
VERCEL_PROJECT_ID
ORACLE_SSH_PRIVATE_KEY
ORACLE_HOST=193.123.190.8
ORACLE_USER=opc
ORACLE_PORT=22
```

`ORACLE_HOST`, `ORACLE_USER`, and `ORACLE_PORT` have workflow defaults, but setting them explicitly is clearer.

The SSH key should be a private key whose public key is present in `/home/opc/.ssh/authorized_keys` on the Oracle server.

## Vercel Setup

Create/import the project in Vercel, then set:

```text
Framework Preset: Vite
Build Command: npm run build --workspace @tac/client
Output Directory: apps/client/dist
Install Command: npm ci
```

The repo includes `vercel.json` with the same settings.

Set production environment variables:

```text
VITE_API_BASE_URL=https://api.your-domain.example/api
VITE_WS_URL=wss://api.your-domain.example
```

## CI/CD

Workflows:

- `.github/workflows/ci.yml` runs typecheck, tests, and build.
- `.github/workflows/deploy.yml` deploys both Vercel client and Oracle server on pushes to `main`, and can also be run manually.

Manual deployment trigger:

```text
GitHub -> Actions -> Deploy -> Run workflow
```

## Smoke Checks

After deployment:

```sh
curl https://api.your-domain.example/api/health
curl https://api.your-domain.example/api/rooms
```

Expected health shape:

```json
{"ok":true,"uptimeSeconds":1,"rooms":0}
```

Then open the Vercel URL and create/join a room.
