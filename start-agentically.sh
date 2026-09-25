#!/usr/bin/env bash
# Agentically — Desktop (macOS / Linux). Run: ./start-agentically.sh
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it free at https://nodejs.org then run this again."
  exit 1
fi

[ -d node_modules ] || { echo "First run - installing components..."; npm install --omit=dev; }

export AGENTICALLY_LOCAL=1
export PORT=4317
export DATA_DIR="$(pwd)/data"

echo ""
echo " Agentically HQ is starting on http://localhost:4317/app"
echo " Keep this window open while you use it. Ctrl+C to stop."
echo ""
(sleep 2; command -v open >/dev/null && open http://localhost:4317/app || true) &
node server.js
