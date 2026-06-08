#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

(sleep 1.2 && open "http://127.0.0.1:8787") &
./start-control-panel.sh
