# builder-image

Node 22 + pnpm + Playwright/Chromium + OpenCode. Serves a project's Vite dev
server on port 3000 and ships a pre-publish site checker. With
`OPENCODE_ENABLED=1` it also runs the OpenCode HTTP server on loopback for the
panel's builder runtime.

## Build

```bash
docker build -t builder-image .
```

## Run

```bash
docker run --rm -p 3000:3000 builder-image
```

The entrypoint installs dependencies with pnpm (falling back to npm) whenever
`package.json` changed since the last install (tracked via a marker inside
`node_modules`), then runs `npm run dev` on port 3000. Set `PREVIEW_HOST` to
allow that host in Vite. The container runs as the unprivileged `node` user.

## OpenCode

Set `OPENCODE_ENABLED=1` to start `opencode serve` on `127.0.0.1:4096` next to
Vite. The port is not published: the panel reaches it through the same
`docker exec` channel the builder tools use.

- `OPENCODE_PASSWORD` is required when enabled; the server uses it for Basic auth.
- `SHIKA_LLM_BASE_URL` points the DeepSeek provider at the panel's LLM gateway.
- `SHIKA_LLM_TOKEN` is the per-session credential. `DEEPSEEK_API_KEY` also works
  for a direct local run.
- `OPENCODE_SERVER_PORT` overrides the loopback port (default 4096).

The global config lives at `~/.config/opencode/opencode.json`. It pins
`deepseek/deepseek-flash`, disables self-update, and denies the free `opencode`
provider so a turn cannot silently fall back to it.

The entrypoint drops `OPENCODE_PASSWORD`, `SHIKA_LLM_TOKEN` and
`DEEPSEEK_API_KEY` from the environment before starting Vite, so the dev server
and the site code do not inherit the credential. The OpenCode process still
holds it; a separate Unix user for the server is the next hardening step if
agent-authored site code is treated as hostile.

## The site check

```bash
node /opt/builder-image/verify.mjs http://127.0.0.1:3000
```

Walks every page reachable from that URL at phone (375px), tablet (768px),
desktop (1440px) and a 200% zoom viewport, plus a forced dark colour scheme and
a phone user agent, and checks layout, colour contrast, accessibility, content,
navigation, forms, media, performance, SEO and security. It also scans the
project source for things that cannot be seen in the DOM.

Findings come back as JSON between `__SITE_CHECK_START__` and
`__SITE_CHECK_END__`. Each check is graded `block` (keeps the site
unpublished), `warn` (reported, never blocks) or `skip` (not observable in a dev
preview, with the reason recorded). Exit status is non-zero when a blocking
check fails, but the report is the source of truth. It takes no screenshots.

Environment overrides: `SITE_CHECK_BUDGET_SECONDS` (default 240) and
`SITE_CHECK_WORKSPACE` (default `/workspace`).

## Publish

The workflow builds and pushes `ghcr.io/<owner>/builder-image` (`latest` plus the
git sha) on push, on the weekly schedule, or manually.

## How the panel uses this image

The AI Builder panel does **not** build a per-session Dockerfile. It creates each
preview as a Coolify application from
`ghcr.io/<owner>/builder-image:latest`. When a node's copy is missing or differs
from the panel's templates (checker, entrypoint, starter), the panel pulls the
latest publish and uses it — a panel/registry skew is a release note, not a
blocker. Only a node with no image at all fails.

After a publish, run `php artisan builder:pull-image` on the fleet. A node that
still has the old image is reported by `builder:image-status` for follow-up; the
next preview pulls it automatically.

`builder:build-image` can build the same image locally on a node from the
panel's vendored copy. That local build is the offline/self-hosted fallback as
the fleet expands; a self-hosted registry is the planned next step, with Docker
Hub as a second mirror.

## Files

- `Dockerfile`
- `entrypoint.sh`
- `opencode.json` — OpenCode global config: pinned model, self-update off, free provider denied.
- `package.json` — the starter a project is built from.
- `tools-package.json` — dependencies for the site checker only, installed into `/opt/builder-image` so
  Playwright never lands in a project's own build.
- `verify.mjs` — the pre-publish site check.
