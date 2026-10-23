#!/usr/bin/env bash
set -euo pipefail

cd /workspace

# A restored container keeps node_modules across hydration, so the installed
# tree can outlive the package.json it was installed from. Reinstall whenever
# the manifest changed since the last install (marker inside node_modules).
deps_current() {
  [ -f package.json ] || return 1
  want="$(sha256sum package.json | cut -d' ' -f1)"
  have="$(cat node_modules/.shika-deps 2>/dev/null || true)"
  [ "$want" = "$have" ]
}

if [ ! -d node_modules ] || ! deps_current; then
  pnpm install --prefer-offline --no-frozen-lockfile || npm install --no-audit --no-fund
  sha256sum package.json | cut -d' ' -f1 > node_modules/.shika-deps
fi

if [ -n "${PREVIEW_HOST:-}" ]; then
  # Allow the project's own preview host and any sibling host under the same
  # parent domain (leading dot), so a preview URL is not rejected by Vite's
  # host check with a bare 403.
  parent=".${PREVIEW_HOST#*.}"
  export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="${PREVIEW_HOST},${parent}"
fi

exec npm run dev -- --host 0.0.0.0 --port 3000
