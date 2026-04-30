#!/bin/bash
# dev-server.sh — Start a throwaway dev server for testing.
#
# Runs in the foreground, prints connection info, and exits. Do NOT background it.
#
#   ./dev-server.sh                     Start server for current directory
#   ./dev-server.sh /path/to/worktree   Start server for a specific worktree
#   ./dev-server.sh --stop              Stop the server for this directory
#   ./dev-server.sh --status            Check if a server is running
#
# Output includes a ---DEV-SERVER-INFO--- block with URL, PORT, PID, LOG.
# The server auto-exits after 4 hours. Re-running kills the previous instance.

set -e

LOG_DIR="/tmp/agents-orchestrator"
DATA_DIR="$HOME/.dev-agents-orchestrator"
ENV_FILE="$HOME/agents-orchestrator/.env"

ACTION="start"
TARGET_DIR=""

for arg in "$@"; do
  case "$arg" in
    --stop) ACTION="stop" ;;
    --status) ACTION="status" ;;
    *) TARGET_DIR="$arg" ;;
  esac
done

TARGET_DIR="${TARGET_DIR:-$PWD}"

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Error: directory '$TARGET_DIR' does not exist" >&2
  exit 1
fi

cd "$TARGET_DIR"

INFO_FILE=".dev-server.info"
OLD_PID_FILE=".dev-server.pid"

read_info() {
  if [[ -f "$INFO_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$INFO_FILE"
    echo "$DEV_PID"
  elif [[ -f "$OLD_PID_FILE" ]]; then
    cat "$OLD_PID_FILE"
  fi
}

kill_existing() {
  local pid
  pid=$(read_info)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 0.3
  fi
  rm -f "$INFO_FILE" "$OLD_PID_FILE"
}

# --stop: kill and exit
if [[ "$ACTION" == "stop" ]]; then
  pid=$(read_info)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    rm -f "$INFO_FILE" "$OLD_PID_FILE"
    echo "Stopped dev server (PID $pid)"
  else
    rm -f "$INFO_FILE" "$OLD_PID_FILE"
    echo "No running dev server found for $TARGET_DIR"
  fi
  exit 0
fi

# --status: check and print info
if [[ "$ACTION" == "status" ]]; then
  if [[ -f "$INFO_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$INFO_FILE"
    if kill -0 "$DEV_PID" 2>/dev/null; then
      echo "---DEV-SERVER-INFO---"
      echo "STATUS=running"
      echo "URL=http://127.0.0.1:${DEV_PORT}"
      echo "PORT=$DEV_PORT"
      echo "PID=$DEV_PID"
      echo "LOG=$DEV_LOG"
      echo "DATA_DIR=$DATA_DIR"
      echo "WORKTREE=$TARGET_DIR"
      echo "---END-DEV-SERVER-INFO---"
    else
      rm -f "$INFO_FILE"
      echo "No running dev server (stale info file removed)"
    fi
  else
    echo "No dev server running for $TARGET_DIR"
  fi
  exit 0
fi

# --- start ---

if [[ ! -f "$TARGET_DIR/package.json" ]]; then
  echo "Error: no package.json found in '$TARGET_DIR'" >&2
  exit 1
fi

kill_existing

mkdir -p "$LOG_DIR"
INSTALL_LOG=$(mktemp "$LOG_DIR/bun-install-XXXXXX.log")
if ! bun i > "$INSTALL_LOG" 2>&1; then
  echo "Error: bun install failed:" >&2
  cat "$INSTALL_LOG" >&2
  rm -f "$INSTALL_LOG"
  exit 1
fi
rm -f "$INSTALL_LOG"

PORT=$(( (RANDOM % 16900) + 3100 ))
LOG_FILE=$(mktemp "$LOG_DIR/dev-server-XXXXXX.log")

PORT=$PORT AGENT_ORCHESTRATOR_DIR=$DATA_DIR \
  timeout 4h bun --env-file="$ENV_FILE" run dev > "$LOG_FILE" 2>&1 &
PID=$!

# Wait for the server to be ready (up to 10s)
READY=false
for _ in $(seq 1 20); do
  if grep -q "server listening" "$LOG_FILE" 2>/dev/null; then
    READY=true
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "---DEV-SERVER-INFO---"
    echo "STATUS=failed"
    echo "ERROR=Server process exited unexpectedly"
    echo "LOG=$LOG_FILE"
    echo "---END-DEV-SERVER-INFO---"
    exit 1
  fi
  sleep 0.5
done

if [[ "$READY" != "true" ]]; then
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "---DEV-SERVER-INFO---"
    echo "STATUS=failed"
    echo "ERROR=Server process exited during startup"
    echo "LOG=$LOG_FILE"
    echo "---END-DEV-SERVER-INFO---"
    exit 1
  fi
  # Still running but slow — continue with a warning
  echo "Warning: server did not confirm ready within 10s (may still be starting)" >&2
fi

cat > "$INFO_FILE" <<EOF
DEV_PID=$PID
DEV_PORT=$PORT
DEV_LOG=$LOG_FILE
EOF

echo "---DEV-SERVER-INFO---"
echo "STATUS=running"
echo "URL=http://127.0.0.1:${PORT}"
echo "PORT=$PORT"
echo "PID=$PID"
echo "LOG=$LOG_FILE"
echo "DATA_DIR=$DATA_DIR"
echo "WORKTREE=$TARGET_DIR"
echo "---END-DEV-SERVER-INFO---"
