#!/bin/bash
# Build and serve the web app as a hosted demo (see docs/hosted-demo.md). Run from a clone of the repository:
#   bash app/scripts/hosted-demo.sh
# The keys and the access code come from the environment (KITTY_HOSTED_*, RUNPOD_API_KEY, S3_*), never from files.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${KITTY_HOSTED_ACCESS:?set KITTY_HOSTED_ACCESS (the access code for the demo link)}"
: "${RUNPOD_API_KEY:?set RUNPOD_API_KEY}"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
npm ci --no-audit --no-fund
npm run build
exec npx next start -p "${PORT:-3000}" -H 0.0.0.0
