#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# Ensure Electron runs in app mode even if env var is set globally
unset ELECTRON_RUN_AS_NODE

echo "Starting Synthezer desktop app..."
exec npm run desktop

