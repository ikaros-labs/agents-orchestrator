#!/bin/bash
# Usage: ./dev-server.sh [worktree-path]
# Starts a dev server on a random port (3100–19999) for testing changes.
# Auto-exits after 4 hours to avoid forgotten instances.

TARGET_DIR="${1:-$PWD}"
cd "$TARGET_DIR"

bun i

PORT=$((RANDOM + 3100))
LOG_FILE=$(mktemp /tmp/dev-server-XXXXXX.log)

HOST=100.81.181.2 PORT=$PORT timeout 4h bun --env-file=/root/agents-orchestrator/.env run dev > "$LOG_FILE" 2>&1 &
PID=$!

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
