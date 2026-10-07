#!/usr/bin/env bash
# Starts the prod server and a Cloudflare quick tunnel. Prints the public URL.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed. Run: brew install cloudflared" >&2
  exit 1
fi
PORT="${PORT:-$(node -e "const s=require('net').createServer().listen(0,()=>{console.log(s.address().port);s.close()})")}"
export PORT
[ -d dist ] || npm run build
LOG="$(mktemp)"
npm start >"$LOG.server" 2>&1 &
SERVER_PID=$!
cloudflared tunnel --url "http://localhost:$PORT" >"$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'pkill -P $SERVER_PID 2>/dev/null; kill $SERVER_PID $TUNNEL_PID 2>/dev/null; rm -f "$LOG" "$LOG.server"' EXIT INT TERM
for _ in $(seq 1 60); do
  URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "${URL:-}" ] || { echo "No tunnel URL after 60s. Log:" >&2; cat "$LOG" >&2; exit 1; }
echo "Local:  http://localhost:$PORT/host"
echo "Public: $URL/host   (open this on the TV)"
echo "Press Ctrl+C to stop."
wait $TUNNEL_PID
