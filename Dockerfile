# syntax=docker/dockerfile:1.4
FROM node:22.23.4-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PORT=3000

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

COPY index.html /workspace/index.html
COPY package.json /workspace/package.json
COPY vite.config.js /workspace/vite.config.js
COPY tailwind.config.js /workspace/tailwind.config.js
COPY postcss.config.js /workspace/postcss.config.js
COPY src/main.jsx /workspace/src/main.jsx
COPY src/App.jsx /workspace/src/App.jsx
COPY src/index.css /workspace/src/index.css

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# The dev server, installs and the site checker all run unprivileged: agent-
# authored package.json scripts must not execute as root. /ms-playwright stays
# world-readable (no chown needed); /pnpm is pnpm's store/home.
RUN mkdir -p /pnpm \
    && chown -R node:node /workspace /opt/builder-image /pnpm
USER node

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
