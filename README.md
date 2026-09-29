# builder-image

Node 22 + pnpm + Playwright/Chromium. Runs a project's dev server and checks a
page in a headless browser.

## Build

```bash
docker build -t builder-image .
```

## Run

```bash
docker run --rm -p 3000:3000 builder-image
```

The entrypoint waits for `/workspace/package.json`, installs dependencies with
pnpm (falling back to npm), then runs `npm run dev` on port 3000. Set
`PREVIEW_HOST` to allow that host in Vite.

## Publish

The workflow builds and pushes `ghcr.io/<owner>/builder-image` (`latest` plus the
git sha) on push, on the weekly schedule, or manually.

## Files

- `Dockerfile`
- `entrypoint.sh`
- `package.json`
- `verify.mjs` — headless browser checks, prints JSON.
