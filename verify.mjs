#!/usr/bin/env node
//
// Checks a page in a headless browser and prints a JSON report.
//
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const url = process.argv[2] ?? 'http://127.0.0.1:3000';
const outDir = process.argv[3] ?? '/workspace/.builder';

const viewports = [
  { name: 'phone', width: 360, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
];

let AxeBuilder = null;
try {
  ({ AxeBuilder } = await import('@axe-core/playwright'));
} catch {
  // axe is optional; accessibility is skipped when it is not installed.
}

const checks = [];
const consoleErrors = [];
const screenshots = [];

const browser = await chromium.launch({ args: ['--no-sandbox'] });

try {
  await mkdir(outDir, { recursive: true });

  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const page = await context.newPage();

    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => consoleErrors.push(String(error?.message ?? error)));
    page.on('requestfailed', (request) => consoleErrors.push(`request failed: ${request.url()}`));

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(400);

    const h1Count = await page.locator('h1').count();
    checks.push({ name: `one h1 (${viewport.name})`, passed: h1Count === 1, detail: `${h1Count} h1 element(s)` });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    checks.push({ name: `no horizontal overflow (${viewport.name})`, passed: !overflow, detail: overflow ? 'page scrolls sideways' : 'ok' });

    const landmarks = await page.evaluate(() => ({
      nav: !!document.querySelector('nav, [role="navigation"]'),
      main: !!document.querySelector('main, [role="main"]'),
    }));
    checks.push({ name: `landmarks present (${viewport.name})`, passed: landmarks.nav && landmarks.main, detail: JSON.stringify(landmarks) });

    const overlaps = await page.evaluate((selectors) => {
      const elements = selectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector)).map((element) => ({ selector, element })),
      );
      const hits = [];
      for (let i = 0; i < elements.length; i += 1) {
        for (let j = i + 1; j < elements.length; j += 1) {
          const a = elements[i];
          const b = elements[j];
          // Nested elements (nav inside header) always overlap; not a bug.
          if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
          const ra = a.element.getBoundingClientRect();
          const rb = b.element.getBoundingClientRect();
          if (ra.width === 0 || rb.width === 0) continue;
          const overlapX = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
          const overlapY = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
          if (overlapX * overlapY > 0.25 * Math.min(ra.width * ra.height, rb.width * rb.height)) {
            hits.push(`${a.selector} over ${b.selector}`);
          }
        }
      }
      return hits;
    }, ['header', 'main', 'footer', 'nav']);

    checks.push({ name: `no overlapping key elements (${viewport.name})`, passed: overlaps.length === 0, detail: overlaps.slice(0, 5).join(', ') || 'ok' });

    const shot = `${outDir}/verify-${viewport.name}.png`;
    await page.screenshot({ path: shot, fullPage: true });
    screenshots.push(shot);

    if (viewport.name === 'desktop' && AxeBuilder) {
      const { violations } = await new AxeBuilder({ page }).analyze();
      const serious = violations.filter((violation) => ['critical', 'serious'].includes(violation.impact));
      checks.push({ name: 'accessibility (axe)', passed: serious.length === 0, detail: serious.map((violation) => violation.id).join(', ') || 'ok' });
    }

    await context.close();
  }

  checks.push({ name: 'no console errors', passed: consoleErrors.length === 0, detail: consoleErrors.slice(0, 5).join(' | ') || 'ok' });
} catch (error) {
  checks.push({ name: 'verification ran', passed: false, detail: String(error?.message ?? error) });
} finally {
  await browser.close();
}

const failed = checks.filter((check) => !check.passed);

console.log(JSON.stringify({ ok: failed.length === 0, checks, consoleErrors, screenshots }, null, 2));

process.exit(failed.length === 0 ? 0 : 1);
