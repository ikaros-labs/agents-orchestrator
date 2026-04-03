#!/usr/bin/env bash
# Build the Docker image for sandboxed agent workers.
# Usage: ./docker/build.sh [--no-cache]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
docker build "$@" -t agents-orchestrator-worker:latest -f "$SCRIPT_DIR/Dockerfile" "$SCRIPT_DIR"
echo "Built agents-orchestrator-worker:latest"
