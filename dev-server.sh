#!/bin/bash
# Usage: ./dev-server.sh [worktree-path]
# Starts a dev server on a random port (3100–19999) for testing changes.
# Auto-exits after 4 hours to avoid forgotten instances.

TARGET_DIR="${1:-$PWD}"
cd "$TARGET_DIR"

bun i

PORT=$((RANDOM + 3100)) HOST=100.81.181.2 timeout 4h bun --env-file=/root/agents-orchestrator/.env run dev
