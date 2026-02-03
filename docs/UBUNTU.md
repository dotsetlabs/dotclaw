# Ubuntu VPS Setup Notes

These are practical, production-friendly notes for running DotClaw on an Ubuntu VPS.

## Prerequisites
- Node.js 20/22 LTS (recommended).
- Docker installed and running.
- The service user must be in the `docker` group (or use rootless Docker).

## Build + Container Image
```bash
npm install
npm run build
./container/build.sh
```

## Systemd Service
An example unit file is in `systemd/dotclaw.service`. Copy it to your system and adjust paths/user:

```bash
sudo cp systemd/dotclaw.service /etc/systemd/system/dotclaw.service
sudo systemctl daemon-reload
sudo systemctl enable --now dotclaw
sudo systemctl status dotclaw
```

Logs:
```bash
sudo journalctl -u dotclaw -f
```

## Recommended Env Tuning (VPS)
Add these to `.env` as needed:
- `CONTAINER_TIMEOUT=300000` (5 minutes) or higher if needed.
- `DOTCLAW_TELEGRAM_HANDLER_TIMEOUT_MS=330000` (should be >= `CONTAINER_TIMEOUT`).
- `DOTCLAW_OPENROUTER_TIMEOUT_MS=240000` (OpenRouter request timeout).
- `DOTCLAW_OPENROUTER_RETRY=true` (retry transient OpenRouter failures).
- `DOTCLAW_TELEGRAM_SEND_RETRIES=3` (retry Telegram sends).
- `CONTAINER_MEMORY=2g` and/or `CONTAINER_CPUS=2` for resource limits.

## Permissions
On Linux, the container runs as the host UID/GID by default. Make sure your service user owns:
- `data/`
- `groups/`
- `store/`

If you see IPC or session permission errors, fix ownership:
```bash
sudo chown -R $USER:$USER data groups store
```

## Quick Health Check
```bash
npm run doctor
```
