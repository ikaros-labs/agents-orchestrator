#!/bin/bash
# Starts the dev server (watch mode) on a random port.
# Usage: ./dev-server.sh [worktree-path]
#
# Picks a random port in 3100–19999, installs deps, starts bun dev,
# and prints the URL. PID and logs go to /tmp/agents-orchestrator-dev.{pid,log}.

set -e

PID_FILE="/tmp/agents-orchestrator-dev.pid"
LOG_FILE="/tmp/agents-orchestrator-dev.log"

ENV_FILE="/root/agents-orchestrator/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

TARGET_DIR="${1:-$PWD}"

if [[ ! -f "$TARGET_DIR/package.json" ]]; then
  echo "Error: no package.json found in '$TARGET_DIR'" >&2
  exit 1
fi

# Kill existing dev server via PID file
if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping dev server (PID $OLD_PID)..."
    kill "$OLD_PID"
    sleep 0.5
  fi
  rm -f "$PID_FILE"
fi

PORT=$((RANDOM + 3100))
HOST="${HOST:-100.81.181.2}"

echo "Starting dev server from '$TARGET_DIR' on port $PORT..."

cd "$TARGET_DIR"
echo "Installing dependencies..."
bun i

HOST="$HOST" PORT="$PORT" bun --env-file="$ENV_FILE" run dev > "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

sleep 1

if ! kill -0 "$NEW_PID" 2>/dev/null; then
  echo "Dev server failed to start. Last log output:" >&2
  tail -20 "$LOG_FILE" >&2
  exit 1
fi

echo "Dev server running (PID $NEW_PID) at http://$HOST:$PORT"
echo "Logs: $LOG_FILE"
echo "---"
tail -5 "$LOG_FILE"
