# builder-image

Node 22 + pnpm + Playwright/Chromium. Serves a project's Vite dev server on port
3000 and ships a pre-publish site checker.

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

## Files

- `Dockerfile`
- `entrypoint.sh`
- `package.json` — the starter a project is built from.
- `tools-package.json` — dependencies for the site checker only, installed into `/opt/builder-image` so
  Playwright never lands in a project's own build.
- `verify.mjs` — the pre-publish site check.
