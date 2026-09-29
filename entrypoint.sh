#!/usr/bin/env bash
set -euo pipefail

cd /workspace

while [ ! -f package.json ]; do
  sleep 2
done

if [ ! -d node_modules ]; then
  pnpm install --prefer-offline --no-frozen-lockfile || npm install --no-audit --no-fund
fi

if [ -n "${PREVIEW_HOST:-}" ]; then
  # Allow the site's own preview host and any host under the platform deploy
  # domain (a leading dot matches subdomains), so the studio's preview host is
  # never rejected by Vite's "Blocked request. This host is not allowed." check.
  parent=".${PREVIEW_HOST#*.}"
  export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="${PREVIEW_HOST},${parent}"
fi

exec npm run dev -- --host 0.0.0.0 --port 3000
