#!/usr/bin/env bash
# One-shot VPS bootstrap for the Jupiter smart-money bot.
# Run on the VPS after extracting the bundle into ~/jup-copy-bot.
set -euo pipefail

cd "$(dirname "$0")/.."   # project root
echo "==> project: $(pwd)"

# 1. Node.js (>=20). Install via NodeSource if missing/old.
need_node() { ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; }
if need_node; then
  echo "==> installing Node.js 20 LTS"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "==> node $(node --version), npm $(npm --version)"

# 2. screen
command -v screen >/dev/null 2>&1 || { echo "==> installing screen"; apt-get install -y screen; }

# 3. deps
echo "==> npm install"
npm install --no-audit --no-fund

# 4. sanity: tests
echo "==> running tests"
npm test || { echo "!! tests failed — aborting"; exit 1; }

# 5. (re)start under a detached screen session named 'smartmoney'
SESSION=smartmoney
screen -S "$SESSION" -X quit >/dev/null 2>&1 || true
screen -dmS "$SESSION" bash -lc 'cd ~/jup-copy-bot && npm start 2>&1 | tee -a bot.log'
sleep 3
echo "==> started. sessions:"
screen -ls || true
echo
echo "Attach with:  screen -r $SESSION   (detach: Ctrl+A then D)"
echo "Logs:         tail -f ~/jup-copy-bot/bot.log"
