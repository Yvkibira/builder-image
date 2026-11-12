# syntax=docker/dockerfile:1.4
FROM node:22.23.4-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PORT=3000 \
    npm_config_store_dir=/pnpm/store

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates unzip zip bash \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libpango-1.0-0 libcairo2 libasound2 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9.15.0

# The site checker and its dependencies live in /opt/builder-image and use their
# own manifest, so installing Playwright here never ends up in a project's
# /workspace build. `npx playwright install` only downloads the browser binary —
# the `playwright` module itself has to be a real dependency for verify.mjs to
# import it, which is why it is declared in tools-package.json.
WORKDIR /opt/builder-image
COPY tools-package.json /opt/builder-image/package.json
RUN npm install --omit=dev \
    && npx playwright install --with-deps --only-shell chromium
COPY verify.mjs /opt/builder-image/verify.mjs

WORKDIR /workspace

# The site's runtime is installed here, once, instead of on the first request of
# every container: React, Vite and Tailwind plus the router, the icon set and the
# component toolkit. `node_modules/.shika-deps` records the manifest hash that
# entrypoint.sh compares against, so a boot with an untouched package.json skips
# `pnpm install` entirely. The store stays in /pnpm so an on-demand
# `shika-add` can install without downloading the common case.
COPY package.json /workspace/package.json
RUN pnpm install --no-frozen-lockfile \
    && sha256sum package.json | cut -d' ' -f1 > node_modules/.shika-deps

COPY index.html /workspace/index.html
COPY vite.config.js /workspace/vite.config.js
COPY src/main.jsx /workspace/src/main.jsx
COPY src/App.jsx /workspace/src/App.jsx
COPY src/index.css /workspace/src/index.css
COPY src/lib/utils.js /workspace/src/lib/utils.js

# The component catalogue and the two add-tools. Components are copied into a
# project on demand — no registry fetch and no shadcn CLI — so an agent with no
# terminal can still build a real interface out of real controls.
COPY packages.json /opt/shika/packages.json
COPY shika-add /usr/local/bin/shika-add
COPY shika-add-component /usr/local/bin/shika-add-component
COPY ui/accordion.jsx /opt/shika/ui/accordion.jsx
COPY ui/alert.jsx /opt/shika/ui/alert.jsx
COPY ui/badge.jsx /opt/shika/ui/badge.jsx
COPY ui/button.jsx /opt/shika/ui/button.jsx
COPY ui/card.jsx /opt/shika/ui/card.jsx
COPY ui/dialog.jsx /opt/shika/ui/dialog.jsx
COPY ui/input.jsx /opt/shika/ui/input.jsx
COPY ui/label.jsx /opt/shika/ui/label.jsx
COPY ui/separator.jsx /opt/shika/ui/separator.jsx
COPY ui/tabs.jsx /opt/shika/ui/tabs.jsx
COPY ui/textarea.jsx /opt/shika/ui/textarea.jsx

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/shika-add /usr/local/bin/shika-add-component

# The dev server, installs and the site checker all run unprivileged: agent-
# authored package.json scripts must not execute as root. /ms-playwright stays
# world-readable (no chown needed); /pnpm is pnpm's store/home.
RUN mkdir -p /pnpm \
    && chown -R node:node /workspace /opt/builder-image /opt/shika /pnpm
USER node

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
