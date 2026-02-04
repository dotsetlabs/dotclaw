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

DOTCLAW_CONFIG_DIR="$TARGET_HOME/.config/dotclaw"
PROMPTS_DIR="$DOTCLAW_CONFIG_DIR/prompts"
TRACES_DIR="$DOTCLAW_CONFIG_DIR/traces"

log "Project root: $PROJECT_ROOT"
log "User: $TARGET_USER"
log "Home: $TARGET_HOME"
log "Node: $NODE_PATH"

mkdir -p "$PROMPTS_DIR" "$TRACES_DIR" "$PROJECT_ROOT/logs"

BEHAVIOR_CONFIG_PATH="$DOTCLAW_CONFIG_DIR/behavior.json"
if [[ ! -f "$BEHAVIOR_CONFIG_PATH" ]]; then
  mkdir -p "$DOTCLAW_CONFIG_DIR"
  cat > "$BEHAVIOR_CONFIG_PATH" <<EOF
{
  "tool_calling_bias": 0.5,
  "memory_importance_threshold": 0.55,
  "response_style": "balanced",
  "caution_bias": 0.5,
  "last_updated": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
  chmod 600 "$BEHAVIOR_CONFIG_PATH" || true
fi

if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
  log "Initializing .env and data directories"
  run_as_user "$NODE_PATH $PROJECT_ROOT/scripts/init.js"
fi

update_env() {
  local key="$1"
  local value="$2"
  local env_path="$PROJECT_ROOT/.env"
  if grep -q "^${key}=" "$env_path"; then
    sed -i "s#^${key}=.*#${key}=${value}#" "$env_path"
  else
    echo "${key}=${value}" >> "$env_path"
  fi
}

update_env_default() {
  local key="$1"
  local value="$2"
  local env_path="$PROJECT_ROOT/.env"
  if grep -q "^${key}=" "$env_path"; then
    return
  fi
  echo "${key}=${value}" >> "$env_path"
}

update_env_default "DOTCLAW_PROMPT_PACKS_ENABLED" "true"
update_env_default "DOTCLAW_PROMPT_PACKS_DIR" "$PROMPTS_DIR"
update_env_default "DOTCLAW_PROMPT_PACKS_CANARY_RATE" "0.1"
update_env_default "DOTCLAW_TRACE_DIR" "$TRACES_DIR"
update_env_default "DOTCLAW_CONTAINER_MODE" "daemon"
update_env_default "CONTAINER_TIMEOUT" "900000"
update_env_default "CONTAINER_MAX_OUTPUT_SIZE" "20971520"
update_env_default "DOTCLAW_MAX_CONCURRENT_AGENTS" "4"
update_env_default "DOTCLAW_WARM_START" "true"
update_env_default "DOTCLAW_MAX_TOOL_STEPS" "32"
update_env_default "DOTCLAW_TOOL_OUTPUT_LIMIT_BYTES" "1500000"
update_env_default "DOTCLAW_WEBFETCH_MAX_BYTES" "1500000"
update_env_default "DOTCLAW_PROGRESS_ENABLED" "true"
update_env_default "DOTCLAW_PROGRESS_INITIAL_MS" "30000"
update_env_default "DOTCLAW_PROGRESS_INTERVAL_MS" "60000"
update_env_default "DOTCLAW_PROGRESS_MAX_UPDATES" "3"
update_env_default "DOTCLAW_PERSONALIZATION_CACHE_MS" "300000"
update_env_default "DOTCLAW_BEHAVIOR_CONFIG_PATH" "$DOTCLAW_CONFIG_DIR/behavior.json"

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

AUTOTUNE_ENV="$PROJECT_ROOT/data/autotune.env"
mkdir -p "$PROJECT_ROOT/data"
OPENROUTER_KEY="$(grep -E '^OPENROUTER_API_KEY=' "$PROJECT_ROOT/.env" | head -n1 | cut -d= -f2- || true)"
OPENROUTER_SITE_URL="$(grep -E '^OPENROUTER_SITE_URL=' "$PROJECT_ROOT/.env" | head -n1 | cut -d= -f2- || true)"
OPENROUTER_SITE_NAME="$(grep -E '^OPENROUTER_SITE_NAME=' "$PROJECT_ROOT/.env" | head -n1 | cut -d= -f2- || true)"

if [[ -d "$AUTOTUNE_DIR" ]]; then
  cat > "$AUTOTUNE_ENV" <<EOF
OPENROUTER_API_KEY=$OPENROUTER_KEY
OPENROUTER_SITE_URL=$OPENROUTER_SITE_URL
OPENROUTER_SITE_NAME=${OPENROUTER_SITE_NAME:-DotClaw}
AUTOTUNE_OUTPUT_DIR=$PROMPTS_DIR
AUTOTUNE_TRACE_DIR=$TRACES_DIR
AUTOTUNE_BEHAVIOR_ENABLED=1
AUTOTUNE_BEHAVIOR_CONFIG_PATH=$DOTCLAW_CONFIG_DIR/behavior.json
AUTOTUNE_BEHAVIOR_REPORT_DIR=$PROJECT_ROOT/data
EOF
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
Description=DotClaw Telegram Assistant
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=$TARGET_USER
WorkingDirectory=$PROJECT_ROOT
Environment=NODE_ENV=production
Environment=HOME=$TARGET_HOME
EnvironmentFile=$PROJECT_ROOT/.env
ExecStart=$NODE_PATH $PROJECT_ROOT/dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
KillMode=mixed
KillSignal=SIGINT
StandardOutput=append:$PROJECT_ROOT/logs/dotclaw.log
StandardError=append:$PROJECT_ROOT/logs/dotclaw.error.log

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
