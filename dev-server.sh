#!/bin/bash
# Usage: ./dev-server.sh [worktree-path]
# Starts a dev server on a random port (3100–19999) for testing changes.
# PID: /tmp/agents-orchestrator-dev.pid  Logs: /tmp/agents-orchestrator-dev.log

TARGET_DIR="${1:-$PWD}"
cd "$TARGET_DIR"

bun i

PORT=$((RANDOM + 3100)) HOST=100.81.181.2 bun --env-file=/root/agents-orchestrator/.env run dev
