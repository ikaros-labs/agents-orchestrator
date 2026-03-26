#!/bin/bash
# Usage: ./server.sh [worktree-path] [--dev]
#   worktree-path  Directory to run the server from (default: current directory)
#   --dev          Run in watch mode (bun run dev) instead of bun run start

set -e

PID_FILE="/tmp/agents-orchestrator.pid"
LOG_FILE="/tmp/agents-orchestrator.log"

ENV_FILE="/root/agents-orchestrator/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

PORT="${PORT:-3000}"

TARGET_DIR=""
DEV_MODE=false

for arg in "$@"; do
  case "$arg" in
    --dev) DEV_MODE=true ;;
    *) TARGET_DIR="$arg" ;;
  esac
done

TARGET_DIR="${TARGET_DIR:-$PWD}"

if [[ ! -f "$TARGET_DIR/package.json" ]]; then
  echo "Error: no package.json found in '$TARGET_DIR'" >&2
  exit 1
fi

# Kill existing server via PID file
if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping server (PID $OLD_PID)..."
    kill "$OLD_PID"
    sleep 0.5
  fi
  rm -f "$PID_FILE"
fi

# Fallback: kill anything still holding the port
STALE_PID=$(lsof -ti:"$PORT" 2>/dev/null || true)
if [[ -n "$STALE_PID" ]]; then
  echo "Killing stale process on port $PORT (PID $STALE_PID)..."
  kill "$STALE_PID" 2>/dev/null || true
  sleep 0.5
fi

CMD="bun run $( $DEV_MODE && echo dev || echo start )"
echo "Starting server from '$TARGET_DIR' ($CMD)..."

cd "$TARGET_DIR"
$CMD > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 1

if ! kill -0 "$NEW_PID" 2>/dev/null; then
  echo "Server failed to start. Last log output:" >&2
  tail -20 "$LOG_FILE" >&2
  exit 1
fi

echo "Server running (PID $NEW_PID) on port $PORT"
echo "Logs: $LOG_FILE"
echo "---"
tail -5 "$LOG_FILE"
