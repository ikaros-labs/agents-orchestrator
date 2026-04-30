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
mkdir -p /tmp/agents-orchestrator
LOG_FILE=$(mktemp /tmp/agents-orchestrator/dev-server-XXXXXX.log)

PORT=$PORT AGENT_ORCHESTRATOR_DIR=$HOME/.dev-agents-orchestrator \
  timeout 4h bun --env-file=$HOME/agents-orchestrator/.env run dev > "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"

# Wait for the server to print its URL (up to 10s)
for i in $(seq 1 20); do
  if grep -q "Listening on" "$LOG_FILE" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "Server failed to start:" >&2
    cat "$LOG_FILE" >&2
    exit 1
  fi
  sleep 0.5
done

echo "Dev server running (PID $PID) — logs: $LOG_FILE"
grep "Listening on" "$LOG_FILE" | tail -1
