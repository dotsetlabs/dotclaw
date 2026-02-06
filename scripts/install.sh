#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[dotclaw-install] $*"
}

warn() {
  echo "[dotclaw-install] WARN: $*" >&2
}

die() {
  echo "[dotclaw-install] ERROR: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_USER="${SUDO_USER:-$USER}"
TARGET_HOME=""
if command -v getent >/dev/null 2>&1; then
  TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6 || true)"
fi
if [[ -z "$TARGET_HOME" ]]; then
  TARGET_HOME="$(eval echo "~$TARGET_USER" 2>/dev/null || true)"
fi
if [[ -z "$TARGET_HOME" || "$TARGET_HOME" == "~"* ]]; then
  TARGET_HOME="$HOME"
fi

run_as_user() {
  local cmd="$1"
  if [[ "$USER" == "$TARGET_USER" ]]; then
    bash -lc "$cmd"
  else
    sudo -u "$TARGET_USER" bash -lc "$cmd"
  fi
}

NODE_PATH=""
if [[ "$USER" == "root" && -n "${SUDO_USER:-}" ]]; then
  NODE_PATH="$(sudo -u "$TARGET_USER" bash -lc 'command -v node' || true)"
else
  NODE_PATH="$(command -v node || true)"
fi

if [[ -z "$NODE_PATH" ]]; then
  die "node not found in PATH. Install Node 20+ and rerun."
fi

DOTCLAW_HOME="$TARGET_HOME/.dotclaw"
CONFIG_DIR="$DOTCLAW_HOME/config"
DATA_DIR="$DOTCLAW_HOME/data"
GROUPS_DIR="$DOTCLAW_HOME/groups"
PROMPTS_DIR="$DOTCLAW_HOME/prompts"
TRACES_DIR="$DOTCLAW_HOME/traces"
LOGS_DIR="$DOTCLAW_HOME/logs"
ENV_FILE="$DOTCLAW_HOME/.env"

log "Project root: $PROJECT_ROOT"
log "DotClaw home: $DOTCLAW_HOME"
log "User: $TARGET_USER"
log "Home: $TARGET_HOME"
log "Node: $NODE_PATH"

mkdir -p "$CONFIG_DIR" "$DATA_DIR" "$GROUPS_DIR" "$PROMPTS_DIR" "$TRACES_DIR" "$LOGS_DIR"

log "Initializing runtime directories"
run_as_user "$NODE_PATH $PROJECT_ROOT/scripts/init.js"

if [[ ! -f "$CONFIG_DIR/tool-budgets.json" ]]; then
  cp "$PROJECT_ROOT/config-examples/tool-budgets.json" "$CONFIG_DIR/tool-budgets.json"
fi

log "Installing DotClaw dependencies"
run_as_user "cd $PROJECT_ROOT && npm install"
log "Building DotClaw"
run_as_user "cd $PROJECT_ROOT && npm run build"

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    log "Building DotClaw container image"
    run_as_user "cd $PROJECT_ROOT && ./container/build.sh" || warn "Container build failed"
  else
    warn "Docker is not running; skipping container build"
  fi
else
  warn "Docker not found; skipping container build"
fi

AUTOTUNE_DIR="${AUTOTUNE_DIR:-}"
AUTOTUNE_NODE_MODULES_DIR="$PROJECT_ROOT/node_modules/@dotsetlabs/autotune"
if [[ -z "$AUTOTUNE_DIR" ]]; then
  if [[ -d "$AUTOTUNE_NODE_MODULES_DIR" ]]; then
    AUTOTUNE_DIR="$AUTOTUNE_NODE_MODULES_DIR"
  else
    AUTOTUNE_DIR="$PROJECT_ROOT/../autotune"
  fi
fi
if [[ -d "$AUTOTUNE_DIR" ]]; then
  AUTOTUNE_DIR="$(cd "$AUTOTUNE_DIR" && pwd)"
  log "Autotune directory found: $AUTOTUNE_DIR"
  if [[ -d "$AUTOTUNE_DIR/src" ]]; then
    run_as_user "cd $AUTOTUNE_DIR && npm install"
    run_as_user "cd $AUTOTUNE_DIR && npm run build"
  fi
else
  warn "Autotune directory not found at $AUTOTUNE_DIR"
  if [[ -d "$AUTOTUNE_NODE_MODULES_DIR" ]]; then
    warn "Autotune is installed under node_modules."
    warn "Set AUTOTUNE_DIR=$AUTOTUNE_NODE_MODULES_DIR to enable the systemd timer."
  else
    warn "Clone it beside DotClaw to enable automatic self-improvement"
  fi
fi

AUTOTUNE_ENV="$CONFIG_DIR/autotune.env"
OPENROUTER_KEY="$(grep -E '^OPENROUTER_API_KEY=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
OPENROUTER_SITE_URL="$($NODE_PATH -e "const fs=require('fs');const p='$CONFIG_DIR/runtime.json';if(fs.existsSync(p)){const c=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(c?.agent?.openrouter?.siteUrl||'');}")"
OPENROUTER_SITE_NAME="$($NODE_PATH -e "const fs=require('fs');const p='$CONFIG_DIR/runtime.json';if(fs.existsSync(p)){const c=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(c?.agent?.openrouter?.siteName||'');}")"

if [[ -d "$AUTOTUNE_DIR" ]]; then
  cat > "$AUTOTUNE_ENV" <<EOF_ENV
OPENROUTER_API_KEY=$OPENROUTER_KEY
OPENROUTER_SITE_URL=$OPENROUTER_SITE_URL
OPENROUTER_SITE_NAME=${OPENROUTER_SITE_NAME:-DotClaw}
AUTOTUNE_OUTPUT_DIR=$PROMPTS_DIR
AUTOTUNE_TRACE_DIR=$TRACES_DIR
AUTOTUNE_BEHAVIOR_ENABLED=1
AUTOTUNE_BEHAVIOR_CONFIG_PATH=$CONFIG_DIR/behavior.json
AUTOTUNE_BEHAVIOR_REPORT_DIR=$DATA_DIR
EOF_ENV
  chmod 600 "$AUTOTUNE_ENV" || true
  if [[ -z "$OPENROUTER_KEY" ]]; then
    warn "OPENROUTER_API_KEY missing; Autotune will not evaluate or optimize"
  fi
fi

if ! command -v systemctl >/dev/null 2>&1; then
  warn "systemctl not found; skipping systemd setup"
  exit 0
fi

DOTCLAW_SERVICE_CONTENT="[Unit]
Description=DotClaw Assistant
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=$TARGET_USER
WorkingDirectory=$PROJECT_ROOT
Environment=NODE_ENV=production
Environment=HOME=$TARGET_HOME
Environment=DOTCLAW_HOME=$DOTCLAW_HOME
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_PATH $PROJECT_ROOT/dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
KillMode=mixed
KillSignal=SIGINT
StandardOutput=append:$LOGS_DIR/dotclaw.log
StandardError=append:$LOGS_DIR/dotclaw.error.log

[Install]
WantedBy=multi-user.target"

sudo tee /etc/systemd/system/dotclaw.service >/dev/null <<< "$DOTCLAW_SERVICE_CONTENT"

if [[ -d "$AUTOTUNE_DIR" ]]; then
  AUTOTUNE_SERVICE_CONTENT="[Unit]
Description=Autotune Self-Improvement Pipeline
After=network-online.target

[Service]
Type=oneshot
User=$TARGET_USER
WorkingDirectory=$AUTOTUNE_DIR
Environment=NODE_ENV=production
Environment=HOME=$TARGET_HOME
EnvironmentFile=-$AUTOTUNE_ENV
ExecStart=$NODE_PATH $AUTOTUNE_DIR/dist/cli.js once

[Install]
WantedBy=multi-user.target"

  AUTOTUNE_TIMER_CONTENT="[Unit]
Description=Run Autotune hourly

[Timer]
OnBootSec=5m
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target"

  sudo tee /etc/systemd/system/autotune.service >/dev/null <<< "$AUTOTUNE_SERVICE_CONTENT"
  sudo tee /etc/systemd/system/autotune.timer >/dev/null <<< "$AUTOTUNE_TIMER_CONTENT"
fi

sudo systemctl daemon-reload
sudo systemctl enable --now dotclaw.service

if [[ -d "$AUTOTUNE_DIR" ]]; then
  sudo systemctl enable --now autotune.timer
  if [[ -n "$OPENROUTER_KEY" ]]; then
    sudo systemctl start autotune.service || true
  fi
fi

log "Install complete"
log "DotClaw status:"
systemctl status dotclaw.service --no-pager || true
if [[ -d "$AUTOTUNE_DIR" ]]; then
  log "Autotune timer status:"
  systemctl status autotune.timer --no-pager || true
fi
