#!/usr/bin/env bash
set -euo pipefail

cd /workspace

if [ ! -d node_modules ]; then
  pnpm install --prefer-offline --no-frozen-lockfile || npm install --no-audit --no-fund
fi

if [ -n "${PREVIEW_HOST:-}" ]; then
  # Allow the project's own preview host and any sibling host under the same
  # parent domain (leading dot), so a preview URL is not rejected by Vite's
  # host check with a bare 403.
  parent=".${PREVIEW_HOST#*.}"
  export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="${PREVIEW_HOST},${parent}"
fi

exec npm run dev -- --host 0.0.0.0 --port 3000
