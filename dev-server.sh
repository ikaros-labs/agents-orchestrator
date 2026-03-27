#!/bin/bash
# Usage: ./dev-server.sh [worktree-path]
# Starts a dev server on a random port (3100–19999) for testing changes.
# Auto-exits after 4 hours to avoid forgotten instances.
# A per-directory PID file (.dev-server.pid) ensures the previous instance
# from the same directory is killed on re-run.

TARGET_DIR="${1:-$PWD}"
cd "$TARGET_DIR"

PID_FILE=".dev-server.pid"

# Kill existing dev server for this directory
if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping previous dev server (PID $OLD_PID)..."
    kill "$OLD_PID"
    sleep 0.5
  fi
  rm -f "$PID_FILE"
fi

bun i

PORT=$((RANDOM + 3100))
echo "Starting dev server on port $PORT..."
PORT=$PORT HOST=100.81.181.2 timeout 4h bun --env-file=/root/agents-orchestrator/.env run dev &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

echo "Dev server running (PID $NEW_PID) at http://100.81.181.2:$PORT"
