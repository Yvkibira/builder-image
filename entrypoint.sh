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

# OpenCode is opt-in. Until the panel sets OPENCODE_ENABLED=1 the container
# behaves exactly as it did before: one Vite dev server, no extra process.
start_opencode() {
  if [ "${OPENCODE_ENABLED:-0}" != "1" ]; then
    return 1
  fi

  if [ -z "${OPENCODE_PASSWORD:-}" ]; then
    echo "OPENCODE_PASSWORD is required when OPENCODE_ENABLED=1" >&2
    exit 1
  fi

  local port="${OPENCODE_SERVER_PORT:-4096}"

  echo "Starting OpenCode on 127.0.0.1:${port}"
  opencode serve --hostname 127.0.0.1 --port "${port}" &
  OPENCODE_PID=$!

  # OpenCode keeps the credential it was started with. The dev server and the
  # agent-authored site code must not inherit it, so drop it before Vite starts.
  unset OPENCODE_PASSWORD SHIKA_LLM_TOKEN DEEPSEEK_API_KEY
}

cleanup() {
  if [ -n "${OPENCODE_PID:-}" ]; then
    kill -TERM "$OPENCODE_PID" 2>/dev/null || true
  fi

  if [ -n "${VITE_PID:-}" ]; then
    kill -TERM "$VITE_PID" 2>/dev/null || true
  fi
}

if [ "${OPENCODE_ENABLED:-0}" = "1" ]; then
  start_opencode

  npm run dev -- --host 0.0.0.0 --port 3000 &
  VITE_PID=$!

  trap cleanup TERM INT

  set +e
  wait -n "$OPENCODE_PID" "$VITE_PID"
  status=$?
  set -e

  cleanup
  wait || true

  exit "$status"
fi

exec npm run dev -- --host 0.0.0.0 --port 3000
