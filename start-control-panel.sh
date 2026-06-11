#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -d ".venv" ]; then
  # shellcheck disable=SC1091
  source ".venv/bin/activate"
fi

if ! curl -fsS --max-time 1 http://127.0.0.1:3456/targets >/dev/null 2>&1; then
  echo "正在启动 CDP Proxy（Chrome 调试端口 9222 -> 面板代理端口 3456）..."
  node deps/web-access/scripts/cdp-proxy.mjs > /tmp/boss-cdp-proxy.log 2>&1 &
  sleep 2
  if ! curl -fsS --max-time 2 http://127.0.0.1:3456/targets >/dev/null 2>&1; then
    echo "CDP Proxy 尚未就绪。请确认 Chrome 已允许远程调试。"
    echo "详细日志：/tmp/boss-cdp-proxy.log"
    echo "也可以进入面板后点击“启动 CDP Proxy”再次尝试。"
  fi
fi

node dashboard/server.mjs
