#!/bin/bash
set -euo pipefail

CONTENTS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
PROJECT_DIR="$RESOURCES_DIR/project"
RUNTIME_DIR="$RESOURCES_DIR/runtime"
APP_HOME="$HOME/Library/Application Support/BossRecruiting"
CONFIG_DIR="$APP_HOME/config"
DATA_DIR="$APP_HOME/data"
LOG_DIR="$APP_HOME/logs"

mkdir -p "$CONFIG_DIR" "$DATA_DIR/briefs" "$DATA_DIR/candidates" "$DATA_DIR/resumes" "$DATA_DIR/runs" "$LOG_DIR"

if [ ! -f "$CONFIG_DIR/default-config.yaml" ]; then
  cp "$RESOURCES_DIR/defaults/default-config.yaml" "$CONFIG_DIR/default-config.yaml"
fi
if [ ! -f "$CONFIG_DIR/feishu.env" ] && [ -f "$RESOURCES_DIR/defaults/feishu.env" ]; then
  cp "$RESOURCES_DIR/defaults/feishu.env" "$CONFIG_DIR/feishu.env"
  chmod 600 "$CONFIG_DIR/feishu.env"
fi

export PATH="$RUNTIME_DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export BOSS_DATA_ROOT="$DATA_DIR"
export BOSS_CONFIG_ROOT="$CONFIG_DIR"
export BOSS_CONFIG_FILE="$CONFIG_DIR/default-config.yaml"
export FEISHU_ENV_FILE="$CONFIG_DIR/feishu.env"
export BOSS_RESUME_EXTRACTOR="$RUNTIME_DIR/bin/resume-extractor"
export BOSS_VISION_OCR_BIN="$RUNTIME_DIR/bin/boss-vision-ocr"
export BOSS_DASHBOARD_HOST="127.0.0.1"
export BOSS_DASHBOARD_PORT="${BOSS_DASHBOARD_PORT:-8787}"

cd "$PROJECT_DIR"

if /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:${BOSS_DASHBOARD_PORT}/api/health" >/dev/null 2>&1; then
  /usr/bin/open "http://127.0.0.1:${BOSS_DASHBOARD_PORT}"
  exit 0
fi

"$RUNTIME_DIR/bin/node" deps/web-access/scripts/cdp-proxy.mjs >>"$LOG_DIR/cdp-proxy.log" 2>&1 &
PROXY_PID=$!

cleanup() {
  kill "$PROXY_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

(
  for _ in {1..30}; do
    if /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:${BOSS_DASHBOARD_PORT}/api/health" >/dev/null 2>&1; then
      /usr/bin/open "http://127.0.0.1:${BOSS_DASHBOARD_PORT}"
      exit 0
    fi
    sleep 0.25
  done
) &

"$RUNTIME_DIR/bin/node" dashboard/server.mjs >>"$LOG_DIR/dashboard.log" 2>&1
