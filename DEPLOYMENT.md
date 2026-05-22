# Oracle Public IP Deployment

This deployment serves the whole app from the Oracle VM public IP:

```text
http://193.123.190.8
```

The Node server serves the built Phaser client plus API/WebSocket traffic:

```text
/       -> apps/client/dist
/api    -> game API
/ws     -> game WebSocket
```

No domain or Vercel project is required for this setup.

## First-Time Oracle Setup

SSH to the VM:

```sh
ssh opc@193.123.190.8
```

The deploy script installs Node 22 from the official binary tarball if Node is not already present.
For first-time setup, only open HTTP on the VM firewall:

```sh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --reload
```

Also open TCP port `80` in the Oracle Cloud security list or network security group for this instance.

The GitHub deployment workflow installs the systemd service automatically.

## GitHub Secrets

Add these repository secrets:

```text
ORACLE_SSH_PRIVATE_KEY
ORACLE_HOST=193.123.190.8
ORACLE_USER=opc
ORACLE_PORT=22
```

`ORACLE_HOST`, `ORACLE_USER`, and `ORACLE_PORT` have workflow defaults, but setting them explicitly is clearer.

`ORACLE_SSH_PRIVATE_KEY` must be a private key whose public key exists in:

```text
/home/opc/.ssh/authorized_keys
```

## Deploy

Push to `main`, or run:

```text
GitHub -> Actions -> Deploy Oracle -> Run workflow
```

The workflow:

1. Runs `npm ci`.
2. Runs typecheck, tests, and build.
3. Packages a minimal runtime tarball with built JS, built client assets, maps, and runtime package metadata.
4. Uploads the release tarball to Oracle.
5. Installs only production runtime dependencies on the VM.
6. Updates `/opt/tac-shooter/current`.
7. Restarts `tac-shooter`.

## Smoke Checks

After deployment:

```sh
curl http://193.123.190.8/api/health
curl http://193.123.190.8/api/rooms
```

Then open:

```text
http://193.123.190.8
```

## Later Domain/TLS Upgrade

When you buy a domain, point an `A` record at `193.123.190.8`, add HTTPS with certbot, and switch the public URL to the domain.
