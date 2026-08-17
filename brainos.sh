#!/usr/bin/env sh
# BrainOS launcher (macOS/Linux): start the server if it isn't already running,
# then open the dashboard. The Windows twin is brainos.bat.
set -e
cd "$(dirname "$0")"

command -v node >/dev/null 2>&1 || { echo "BrainOS needs Node 20+ (node not found)"; exit 1; }

# Host and port come from config.json (falling back to the server's own defaults).
HOSTPORT=$(node -e "let c={};try{c=require('./config.json')}catch{};console.log((c.host||'127.0.0.1')+' '+(c.port||4321))")
HOST=$(echo "$HOSTPORT" | cut -d' ' -f1)
PORT=$(echo "$HOSTPORT" | cut -d' ' -f2)
URL="http://$HOST:$PORT"

open_url() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"; else open "$1"; fi
}

# Reuse a running instance instead of starting a second one.
if node -e "fetch('$URL/api/graph').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
  echo "BrainOS already running at $URL"
  open_url "$URL"
  exit 0
fi

echo "Starting BrainOS at $URL (Ctrl+C stops it)"
node server.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' INT TERM

for _ in $(seq 1 50); do
  if node -e "fetch('$URL/api/graph').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    open_url "$URL"
    break
  fi
  sleep 0.2
done

wait $SERVER_PID
