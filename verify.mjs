#!/usr/bin/env node
//
// The pre-publish site check.
//
// This ships in the image at /opt/builder-image/verify.mjs and is run by whatever
// drives the build. Callers are told to run it rather than write their own copy:
// it is the gate that decides whether a site may go live, so it has to be the
// same script on every run rather than something re-derived each time.
//
// Usage: node /opt/builder-image/verify.mjs [url] [--budget=<seconds>]
//
// Environment:
//   SITE_CHECK_BUDGET_SECONDS  crawl budget, default 240
//   SITE_CHECK_WORKSPACE       project root to scan for source, default /workspace
//
// Prints a JSON report on stdout between sentinels so a noisy container cannot
// corrupt it, and exits 1 when a blocking check failed. The exit status is only
// for humans and CI; read the report for anything else.
//
// Every check declares a severity:
//   block — a real defect. Any block failure keeps the site unpublished.
//   warn  — worth fixing, reported back, never blocks publishing.
//   skip  — not observable from a Vite dev preview (headers set by the proxy,
//           cross-engine rendering, post-submit states). Recorded with a reason
//           so nobody is told there is coverage there is not.

import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const BLOCK = 'block';
const WARN = 'warn';
const SKIP = 'skip';

const GROUPS = {
  layout: 'Layout & Responsiveness',
  color: 'Colour & Contrast',
  a11y: 'Accessibility (WCAG 2.1 AA)',
  content: 'Content & Typography',
  navigation: 'Navigation & Wayfinding',
  forms: 'Forms & Interactive Elements',
  media: 'Media & Assets',
  technical: 'Performance & Technical',
  seo: 'SEO & Metadata',
  crossbrowser: 'Cross-Browser & Cross-Device',
  security: 'Security',
};

// id -> [group, severity, label]
const REGISTRY = {
  1: ['layout', BLOCK, 'No horizontal overflow'],
  2: ['layout', BLOCK, 'No overlapping key elements'],
  3: ['layout', WARN, 'No clipped or cut-off content'],
  4: ['layout', WARN, 'Images stay inside their container'],
  5: ['layout', WARN, 'Layout adapts across breakpoints'],
  6: ['layout', WARN, 'Touch targets are at least 44x44px'],
  7: ['layout', WARN, 'Text stays readable at 200% zoom'],
  8: ['color', BLOCK, 'Body text meets WCAG AA contrast'],
  9: ['color', WARN, 'Interactive elements meet 3:1 contrast'],
  10: ['color', BLOCK, 'Focus indicators are visible'],
  11: ['color', WARN, 'Information is not conveyed by colour alone'],
  12: ['color', WARN, 'Text stays readable in dark mode'],
  13: ['color', WARN, 'Text stays readable in light mode'],
  14: ['a11y', BLOCK, 'Every image has an alt attribute'],
  15: ['a11y', BLOCK, 'Every form control has a label'],
  16: ['a11y', BLOCK, 'Buttons and links have discernible names'],
  17: ['a11y', BLOCK, 'Heading hierarchy is logical'],
  18: ['a11y', WARN, 'Landmark regions are used correctly'],
  19: ['a11y', WARN, 'A skip-to-content link is present'],
  20: ['a11y', BLOCK, 'Interactive elements are keyboard reachable'],
  21: ['a11y', WARN, 'Focus order follows reading order'],
  22: ['a11y', WARN, 'ARIA attributes are valid and resolve'],
  23: ['a11y', WARN, 'Tables have header associations'],
  24: ['a11y', WARN, 'Lists use semantic markup'],
  25: ['a11y', WARN, 'Frames and iframes have accessible titles'],
  26: ['a11y', WARN, 'Scrollable regions are keyboard accessible'],
  27: ['a11y', WARN, 'Animations respect prefers-reduced-motion'],
  28: ['a11y', WARN, 'No duplicate element ids'],
  29: ['a11y', BLOCK, 'Page language is declared'],
  30: ['content', BLOCK, 'No placeholder text left in the copy'],
  31: ['content', WARN, 'Fonts, sizes and weights are consistent'],
  32: ['content', WARN, 'Line height is comfortable'],
  33: ['content', WARN, 'No text overflow in fixed-height containers'],
  34: ['content', WARN, 'No headings stranded without following content'],
  35: ['content', WARN, 'Link text is descriptive'],
  36: ['content', WARN, 'Capitalisation is consistent'],
  37: ['navigation', WARN, 'Navigation is consistent across pages'],
  38: ['navigation', WARN, 'The current page is indicated in navigation'],
  39: ['navigation', WARN, 'Deep pages have breadcrumbs'],
  40: ['navigation', BLOCK, 'Internal links resolve'],
  41: ['navigation', WARN, 'External links are safe'],
  42: ['navigation', WARN, 'Buttons and links are used for the right job'],
  43: ['forms', WARN, 'Required fields are visually indicated'],
  44: ['forms', WARN, 'Validation errors are associated with their fields'],
  45: ['forms', WARN, 'Error messages are descriptive'],
  46: ['forms', SKIP, 'Success states after form submission'],
  47: ['forms', WARN, 'Async operations expose a busy state'],
  48: ['forms', WARN, 'Inputs use appropriate input types'],
  49: ['forms', WARN, 'Contact inputs declare autocomplete'],
  50: ['forms', WARN, 'Grouped inputs use fieldset and legend'],
  51: ['media', BLOCK, 'Every image loads'],
  52: ['media', WARN, 'Images declare width and height'],
  53: ['media', WARN, 'Videos have captions'],
  54: ['media', WARN, 'Audio has a transcript'],
  55: ['media', WARN, 'SVGs are labelled or marked decorative'],
  56: ['media', WARN, 'Below-fold images are lazy loaded'],
  57: ['technical', BLOCK, 'No uncaught JavaScript errors'],
  58: ['technical', BLOCK, 'No failed network requests'],
  59: ['technical', SKIP, 'Render-blocking resources'],
  60: ['technical', SKIP, 'Caching headers'],
  61: ['technical', WARN, 'No console warnings indicating misconfiguration'],
  62: ['technical', WARN, 'No duplicate CSS or JS loaded twice'],
  63: ['technical', BLOCK, 'Meta viewport is set for mobile'],
  64: ['technical', BLOCK, 'Every page has a title and meta description'],
  65: ['seo', BLOCK, 'Page titles are unique'],
  66: ['seo', BLOCK, 'Every page has a meta description'],
  67: ['seo', WARN, 'Open Graph and Twitter Card tags are present'],
  68: ['seo', WARN, 'Canonical URL is set'],
  69: ['seo', WARN, 'Structured data is valid JSON-LD'],
  70: ['seo', SKIP, 'robots.txt and sitemap.xml'],
  71: ['crossbrowser', SKIP, 'Chrome, Firefox, Safari and Edge'],
  72: ['crossbrowser', WARN, 'iOS and Android rendering'],
  73: ['crossbrowser', WARN, 'Browser-specific CSS prefixes'],
  74: ['crossbrowser', WARN, 'Fallbacks for modern CSS features'],
  75: ['security', BLOCK, 'No mixed content'],
  76: ['security', SKIP, 'Content Security Policy headers'],
  77: ['security', WARN, 'No raw user input rendered as HTML'],
  78: ['security', WARN, 'User input is sanitised before rendering'],
  // axe-core catches WCAG rules that hand-written heuristics miss, and there is
  // no other place for them to run.
  900: ['a11y', BLOCK, 'No serious or critical axe-core violations'],
};

const SKIP_REASONS = {
  46: 'A static preview has no backend to submit to, so a post-submit success state cannot be observed.',
  59: 'The dev preview serves unbundled ES modules; render-blocking behaviour only exists in the production build.',
  60: 'The Vite dev server sets no cache headers. Caching is a concern for whatever proxies the built site.',
  70: 'robots.txt and the sitemap are usually generated when the site is deployed, not by the project source.',
  71: 'This image ships Chromium only. Adding Firefox and WebKit would grow the image and every cold build.',
  76: 'Security headers are set by whatever proxies the built site, not by the dev server.',
};

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'zoom200', width: 720, height: 450 },
];

const MAX_OFFENDERS = 5;

// ---------------------------------------------------------------------------
// In-page helpers. Installed into the page before checks run.
// ---------------------------------------------------------------------------

function installHelpers() {
  // Playwright serialises this function into the page, so it cannot close over
  // anything from this module — every constant it needs is declared inside it.
  const interactiveSelector = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="switch"]',
  ].join(', ');

  const parseColor = (value) => {
    if (!value) return null;
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };

  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };

  const contrast = (a, b) => {
    const la = 0.2126 * channel(a.r) + 0.7152 * channel(a.g) + 0.0722 * channel(a.b);
    const lb = 0.2126 * channel(b.r) + 0.7152 * channel(b.g) + 0.0722 * channel(b.b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });

  const opaqueBackground = (element) => {
    let node = element;
    let base = null;
    let uncertain = false;

    while (node && node.nodeType === 1) {
      const style = getComputedStyle(node);

      if (style.backgroundImage && style.backgroundImage !== 'none') uncertain = true;

      const color = parseColor(style.backgroundColor);
      if (color && color.a > 0) {
        base = base === null ? color : blend(color, base);
        if (base.a >= 0.99) break;
      }

      node = node.parentElement;
    }

    const white = { r: 255, g: 255, b: 255, a: 1 };
    const root = parseColor(getComputedStyle(document.documentElement).backgroundColor);
    const fallback = root && root.a >= 0.99 ? root : white;

    if (base === null) return { color: fallback, uncertain };
    if (base.a >= 0.99) return { color: base, uncertain };

    return { color: blend(base, fallback), uncertain };
  };

  const isVisible = (element) => {
    const style = getComputedStyle(element);
    if ('none' === style.display || 'hidden' === style.visibility || 0 === Number(style.opacity)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const ownText = (element) =>
    Array.from(element.childNodes)
      .filter((node) => 3 === node.nodeType)
      .map((node) => node.textContent.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

  const describe = (element) => {
    const id = element.id ? `#${element.id}` : '';
    const className = typeof element.className === 'string' ? element.className.trim() : '';
    const classes = className ? `.${className.split(/\s+/).slice(0, 3).join('.')}` : '';
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${element.tagName.toLowerCase()}${id}${classes}${text ? ` "${text}"` : ''}`;
  };

  const accessibleName = (element) => {
    const label = element.getAttribute('aria-label');
    if (label && label.trim()) return label.trim();

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => {
          const target = document.getElementById(id);
          return target ? target.textContent || '' : '';
        })
        .join(' ')
        .trim();
      if (text) return text;
    }

    const tag = element.tagName;

    if ('INPUT' === tag || 'SELECT' === tag || 'TEXTAREA' === tag) {
      if (element.id) {
        const explicit = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (explicit && explicit.textContent.trim()) return explicit.textContent.trim();
      }
      const wrapping = element.closest('label');
      if (wrapping && wrapping.textContent.trim()) return wrapping.textContent.trim();

      for (const attribute of ['title', 'placeholder']) {
        const value = element.getAttribute(attribute);
        if (value && value.trim()) return value.trim();
      }

      return '';
    }

    if ('IMG' === tag) return element.getAttribute('alt') || '';

    const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) return text;

    const title = element.getAttribute('title');
    return title && title.trim() ? title.trim() : '';
  };

  // WCAG exempts a link inside a sentence from the 44px target minimum.
  const inSentence = (element) => {
    const parent = element.parentElement;
    if (!parent) return false;
    if (!/^(P|LI|TD|TH|DD|DT|BLOCKQUOTE|SECTION|ARTICLE|H[1-6])$/.test(parent.tagName)) return false;
    return (parent.textContent || '').replace(element.textContent || '', '').trim().length > 0;
  };

  const hasOwnVisibleText = (element) => {
    if (!ownText(element)) return false;
    if (element.closest('script, style, noscript, template')) return false;
    return isVisible(element);
  };

  const textElements = () =>
    Array.from(document.querySelectorAll('body *')).filter(hasOwnVisibleText).slice(0, 600);

  const visibleInteractives = () =>
    Array.from(document.querySelectorAll(window.__sk.interactiveSelector)).filter(isVisible);

  window.__sk = {
    interactiveSelector,
    parseColor,
    contrast,
    opaqueBackground,
    isVisible,
    ownText,
    describe,
    accessibleName,
    inSentence,
    textElements,
    visibleInteractives,
  };
}

// ---------------------------------------------------------------------------
// Report: one entry per check id, accumulating offenders across pages.
// ---------------------------------------------------------------------------

class Report {
  constructor() {
    this.items = new Map();
    this.checkerErrors = [];

    for (const [rawId, [group, severity, label]] of Object.entries(REGISTRY)) {
      const id = Number(rawId);
      this.items.set(id, {
        id,
        group,
        severity,
        label,
        status: SKIP === severity ? 'skip' : 'pass',
        offenders: [],
        note: SKIP_REASONS[id] || null,
      });
    }
  }

  item(id) {
    return this.items.get(id) || null;
  }

  /** Force an item to skip, unless it has already failed somewhere. */
  skip(id, note) {
    const item = this.item(id);
    if (!item) return;
    if ('fail' === item.status || 'warn' === item.status) return;
    item.status = 'skip';
    if (note) item.note = note;
  }

  /** Record a finding. `ok === false` fails a block item and warns on a warn item. */
  add(id, ok, detail, page) {
    const item = this.item(id);
    if (!item || SKIP === item.severity) return;

    if (true === ok) {
      if ('skip' === item.status) item.status = 'pass';
      return;
    }

    if ('fail' !== item.status) item.status = WARN === item.severity ? 'warn' : 'fail';

    const text = page ? `${page}: ${detail}` : String(detail);

    if (item.offenders.includes(text)) return;
    if (item.offenders.length < MAX_OFFENDERS) item.offenders.push(text);
    else if (item.offenders.length === MAX_OFFENDERS) item.offenders.push('…and more');
  }

  checkerError(scope, error) {
    this.checkerErrors.push(`${scope}: ${error && error.message ? error.message : String(error)}`);
  }

  summary() {
    const counts = { total: 0, passed: 0, failed: 0, warned: 0, skipped: 0, blocking: 0 };

    for (const item of this.items.values()) {
      counts.total += 1;

      if ('fail' === item.status) {
        counts.failed += 1;
        if (BLOCK === item.severity) counts.blocking += 1;
      } else if ('warn' === item.status) counts.warned += 1;
      else if ('skip' === item.status) counts.skipped += 1;
      else counts.passed += 1;
    }

    return counts;
  }

  toJSON() {
    return {
      checks: Array.from(this.items.values())
        .map((item) => ({
          id: item.id,
          group: item.group,
          group_label: GROUPS[item.group],
          label: item.label,
          severity: item.severity,
          status: item.status,
          offenders: item.offenders,
          note: item.note,
        }))
        .sort((a, b) => a.id - b.id),
      summary: this.summary(),
    };
  }
}

// ---------------------------------------------------------------------------
// Per-page desktop sweep: contrast, a11y, content, navigation, forms, media, meta.
// ---------------------------------------------------------------------------

async function passDesktop(page, report, meta) {
  const found = await page.evaluate(() => {
    const sk = window.__sk;
    const out = {
      lightContrast: [],
      interactiveContrast: [],
      colourAlone: [],
      missingAlt: [],
      brokenImages: [],
      unsizedImages: [],
      unlabelledControls: [],
      namelessControls: [],
      headings: [],
      landmarks: { header: false, nav: false, main: false, footer: false, mains: 0 },
      skipLink: false,
      unreachable: [],
      positiveTabindex: 0,
      badAria: [],
      tables: [],
      lists: [],
      frames: [],
      scrollables: [],
      duplicateIds: [],
      lang: (document.documentElement.getAttribute('lang') || '').trim(),
      placeholderText: [],
      fontFamilies: {},
      fontSizes: {},
      tightLineHeight: [],
      fixedHeightOverflow: [],
      strandedHeadings: [],
      vagueLinks: [],
      shoutyText: [],
      navSignature: '',
      navLinks: [],
      internalLinks: [],
      externalLinks: [],
      emptyHrefs: 0,
      misuseButtons: [],
      requiredUnmarked: [],
      errorWiring: [],
      vagueErrors: [],
      busyStates: [],
      inputTypes: [],
      autocomplete: [],
      fieldsets: [],
      videos: [],
      audios: [],
      svgs: [],
      lazyImages: [],
      metaViewport: '',
      metaDescription: '',
      title: (document.title || '').trim(),
      canonical: '',
      jsonLd: [],
      ogMissing: [],
      hasBreadcrumb: false,
      insecureResources: [],
      rawHrefProtocols: [],
    };

    // 8 / 13 — body text contrast under the active colour scheme.
    for (const element of sk.textElements()) {
      const style = getComputedStyle(element);
      const foreground = sk.parseColor(style.color);
      if (!foreground) continue;

      const background = sk.opaqueBackground(element);
      if (background.uncertain) continue;

      const size = parseFloat(style.fontSize);
      const weight = Number(style.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      const ratio = sk.contrast(foreground, background.color);

      if (ratio + 0.01 < required) {
        out.lightContrast.push({
          el: sk.describe(element),
          ratio: Math.round(ratio * 100) / 100,
          required,
        });
      }
    }

    // 9 — non-text contrast on interactive controls. Both the fill and the border
  // are judged against what surrounds the control, not against itself.
    for (const element of sk.visibleInteractives()) {
      const style = getComputedStyle(element);
      const surroundings = sk.opaqueBackground(element.parentElement || element);
      if (surroundings.uncertain) continue;

      const own = sk.parseColor(style.backgroundColor);
      const border = sk.parseColor(style.borderTopColor);
      const hasBorder = '0px' !== style.borderTopWidth && border && border.a > 0.1;

      // A white input on a white page is fine when a visible border draws the
      // edge, so the fill is only judged when there is no border to do it.
      if (!hasBorder && own && own.a > 0.1 && sk.contrast(own, surroundings.color) + 0.01 < 3) {
        out.interactiveContrast.push(`${sk.describe(element)} fill ${Math.round(sk.contrast(own, surroundings.color) * 100) / 100}:1`);
      }

      if (hasBorder && sk.contrast(border, surroundings.color) + 0.01 < 3) {
        out.interactiveContrast.push(`${sk.describe(element)} border ${Math.round(sk.contrast(border, surroundings.color) * 100) / 100}:1`);
      }
    }

    // 11 — meaning carried by colour with nothing else to back it up.
    const bodyColor = getComputedStyle(document.body).color;
    for (const link of Array.from(document.querySelectorAll('a[href]')).filter(sk.isVisible)) {
      const style = getComputedStyle(link);
      const decorated =
        'none' !== style.textDecorationLine ||
        '0px' !== style.borderBottomWidth ||
        'none' !== style.backgroundImage;
      if (!decorated && style.color === bodyColor && (link.textContent || '').trim()) {
        out.colourAlone.push(`link "${(link.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)}" is indistinguishable from body text`);
      }
    }
    for (const element of Array.from(document.querySelectorAll('[role="status"], [aria-live], .badge, [class*="dot"], [class*="indicator"]')).filter(sk.isVisible)) {
      if (!(element.textContent || '').trim() && element.querySelector('img[alt]:not([alt=""])')) {
        out.colourAlone.push(`status indicator ${sk.describe(element)} carries its meaning in an image with no text`);
      }
    }

    // 14 / 51 / 52 / 56 — images.
    for (const image of Array.from(document.images)) {
      const visible = sk.isVisible(image);
      if (null === image.getAttribute('alt') && visible) out.missingAlt.push(sk.describe(image));
      if (image.complete && 0 === image.naturalWidth && image.getAttribute('src')) {
        out.brokenImages.push(`${sk.describe(image)} src=${image.getAttribute('src')}`);
      }
      if (!visible) continue;

      const rect = image.getBoundingClientRect();
      if (0 === rect.width || 0 === rect.height) continue;

      if (!image.hasAttribute('width') || !image.hasAttribute('height')) {
        const style = getComputedStyle(image);
        if ('auto' === style.aspectRatio) out.unsizedImages.push(sk.describe(image));
      }

      if (rect.top >= window.innerHeight && 'lazy' !== image.getAttribute('loading')) {
        out.lazyImages.push(sk.describe(image));
      }
    }

    // 15 / 16 — labels and discernible names.
    const noLabelNeeded = new Set(['hidden', 'submit', 'reset', 'button', 'image']);
    for (const control of Array.from(document.querySelectorAll('input, select, textarea'))) {
      const type = (control.getAttribute('type') || 'text').toLowerCase();
      if (noLabelNeeded.has(type)) continue;
      if (sk.isVisible(control) && !sk.accessibleName(control)) out.unlabelledControls.push(sk.describe(control));
    }
    for (const element of sk.visibleInteractives()) {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) continue;
      if (!sk.accessibleName(element)) out.namelessControls.push(sk.describe(element));
    }

    // 17 / 34 — headings.
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).filter(sk.isVisible);
    out.headings = headings.map((heading) => ({ level: Number(heading.tagName[1]), el: sk.describe(heading) }));

    for (const heading of headings) {
      let sibling = heading.nextElementSibling;
      let hasContent = false;
      while (sibling) {
        if (sk.isVisible(sibling) && (sibling.textContent || '').trim()) {
          hasContent = true;
          break;
        }
        sibling = sibling.nextElementSibling;
      }
      if (!hasContent) out.strandedHeadings.push(sk.describe(heading));
    }

    // 18 / 19 / 39 — landmarks, skip link, breadcrumbs.
    out.landmarks = {
      header: !!document.querySelector('header, [role="banner"]'),
      nav: !!document.querySelector('nav, [role="navigation"]'),
      main: !!document.querySelector('main, [role="main"]'),
      footer: !!document.querySelector('footer, [role="contentinfo"]'),
      mains: document.querySelectorAll('main, [role="main"]').length,
    };

    out.skipLink = Array.from(document.querySelectorAll('a[href^="#"]')).some((anchor) => {
      const href = anchor.getAttribute('href');
      return href.length > 1 && (anchor.textContent || '').toLowerCase().includes('skip');
    });

    out.hasBreadcrumb = !!(
      document.querySelector('[aria-label="breadcrumb"], .breadcrumb, [class*="breadcrumb"]') ||
      document.querySelector('nav[aria-label*="readcrumb" i], nav[aria-label*="readcrumb" i]')
    );

    // 20 / 21 — keyboard reachability and tab order.
    for (const element of sk.visibleInteractives()) {
      const tabindex = element.getAttribute('tabindex');
      if (null !== tabindex && -1 === Number(tabindex)) out.unreachable.push(sk.describe(element));
    }
    for (const element of Array.from(document.querySelectorAll('[tabindex]'))) {
      const value = Number(element.getAttribute('tabindex'));
      if (value > 0) {
        out.positiveTabindex += 1;
        if (1 !== value) out.badAria.push(`positive tabindex "${element.getAttribute('tabindex')}" on ${sk.describe(element)}`);
      }
    }

    // 22 — ARIA references must resolve to real elements.
    for (const element of Array.from(document.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();

        if (['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns'].includes(name)) {
          for (const id of attribute.value.split(/\s+/).filter(Boolean)) {
            if (!document.getElementById(id)) out.badAria.push(`${name} points at missing id "${id}"`);
          }
        }

        if ('role' === name && !/^[a-z]+$/.test(attribute.value.trim())) {
          out.badAria.push(`invalid role "${attribute.value}" on ${sk.describe(element)}`);
        }

        if (name.startsWith('aria-') && !/^aria-[a-z]+$/.test(name)) {
          out.badAria.push(`invalid attribute ${name} on ${sk.describe(element)}`);
        }
      }
    }

    // 23 / 24 / 25 / 26 — tables, lists, frames, scroll regions.
    for (const table of Array.from(document.querySelectorAll('table')).filter(sk.isVisible)) {
      const headers = table.querySelectorAll('th');
      const cells = table.querySelectorAll('td');

      if (cells.length > 0 && 0 === headers.length) out.tables.push(`table with ${cells.length} cells and no th`);
      else if (headers.length > 0 && 0 === table.querySelectorAll('th[scope]').length) {
        out.tables.push('table headers have no scope attribute');
      }
    }

    for (const list of Array.from(document.querySelectorAll('ul, ol')).filter(sk.isVisible)) {
      const invalid = Array.from(list.children).filter(
        (child) => !['LI', 'SCRIPT', 'TEMPLATE'].includes(child.tagName),
      );
      if (invalid.length) out.lists.push(`${list.tagName.toLowerCase()} contains ${invalid[0].tagName.toLowerCase()} directly`);
    }

    for (const frame of Array.from(document.querySelectorAll('iframe, frame'))) {
      const title = frame.getAttribute('title');
      if (!title || !title.trim()) out.frames.push(sk.describe(frame));
    }

    for (const element of Array.from(document.querySelectorAll('body *')).filter(sk.isVisible)) {
      const style = getComputedStyle(element);
      const scrollable =
        /(auto|scroll)/.test(style.overflowX + style.overflowY) &&
        (element.scrollHeight > element.clientHeight + 2 || element.scrollWidth > element.clientWidth + 2);
      if (scrollable && null === element.getAttribute('tabindex')) out.scrollables.push(sk.describe(element));
    }

    // 28 — duplicate ids break every aria reference that points at them.
    const seen = new Set();
    for (const element of Array.from(document.querySelectorAll('[id]'))) {
      if (seen.has(element.id)) out.duplicateIds.push(`#${element.id}`);
      seen.add(element.id);
    }

    // 30 — copy that was never replaced.
    const filler = /\b(lorem ipsum|dolor sit amet|consectetur adipiscing|TODO|TBD|FIXME|your (?:text|content|image|photo) here|placeholder text|sample text|coming soon)\b/gi;
    const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ');
    const fillerHits = bodyText.match(filler);
    if (fillerHits) {
      out.placeholderText.push(Array.from(new Set(fillerHits.map((hit) => hit.toLowerCase()))).slice(0, 5).join(', '));
    }

    // 31 / 32 / 33 — typography.
    for (const element of sk.textElements()) {
      const style = getComputedStyle(element);
      out.fontFamilies[style.fontFamily] = true;
      out.fontSizes[`${style.fontSize}/${style.fontWeight}`] = true;

      const lineHeight = parseFloat(style.lineHeight);
      const size = parseFloat(style.fontSize);
      if (Number.isFinite(lineHeight) && size >= 16 && lineHeight / size < 1.3) {
        out.tightLineHeight.push(`${sk.describe(element)} line-height ${style.lineHeight} on ${style.fontSize}`);
      }
    }

    for (const element of Array.from(document.querySelectorAll('body *')).filter(sk.isVisible)) {
      const style = getComputedStyle(element);
      const truncated =
        'ellipsis' === style.textOverflow ||
        'none' !== style.webkitLineClamp ||
        (typeof element.className === 'string' && /truncate|line-clamp|no-scrollbar/.test(element.className));
      if (/px$/.test(style.height) && 'hidden' === style.overflow && !truncated && element.scrollHeight > element.clientHeight + 2) {
        out.fixedHeightOverflow.push(sk.describe(element));
      }
    }

    // 35 / 36 — vague link text, shouted copy.
    const vague = /^(?:click here|here|read more|learn more|more|this link|link|download)$/i;
    for (const link of Array.from(document.querySelectorAll('a[href]')).filter(sk.isVisible)) {
      const text = (link.textContent || '').replace(/\s+/g, ' ').trim();
      if (vague.test(text)) out.vagueLinks.push(`"${text}"`);
    }

    const shouting = bodyText.match(/\b[A-Z][A-Z ]{18,}[A-Z]\b/g);
    if (shouting) out.shoutyText.push(Array.from(new Set(shouting)).slice(0, 3).join(' / '));

    // 37 / 38 — navigation shape and current-page marking.
    const nav = document.querySelector('nav, [role="navigation"]');
    if (nav) {
      out.navLinks = Array.from(nav.querySelectorAll('a[href]')).map((anchor) => ({
        href: anchor.getAttribute('href'),
        text: (anchor.textContent || '').replace(/\s+/g, ' ').trim(),
        current: anchor.getAttribute('aria-current') || '',
      }));
      out.navSignature = out.navLinks.map((link) => `${link.text}->${link.href}`).join('|');
    }

    // 40 / 41 / 42 — link hygiene.
    for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
      const href = anchor.getAttribute('href');
      if (!href || '#' === href) {
        out.emptyHrefs += 1;
        continue;
      }

      let resolved = null;
      try {
        resolved = new URL(href, document.baseURI);
      } catch {
        continue;
      }

      if ('http:' === resolved.protocol && 'https:' === location.protocol) {
        out.insecureResources.push(resolved.href);
      }

      if (resolved.origin === location.origin) {
        out.internalLinks.push({ href, absolute: resolved.href });
      } else {
        out.externalLinks.push({
          href: resolved.href,
          target: anchor.getAttribute('target') || '',
          rel: anchor.getAttribute('rel') || '',
        });
      }
    }

    for (const anchor of document.querySelectorAll('a[href^="javascript:"]')) {
      out.rawHrefProtocols.push(anchor.getAttribute('href').slice(0, 40));
    }

    for (const element of Array.from(document.querySelectorAll('[onclick], [role="button"]'))) {
      if (!['BUTTON', 'A'].includes(element.tagName) && null === element.getAttribute('tabindex')) {
        out.misuseButtons.push(`${sk.describe(element)} reacts to clicks but cannot be focused`);
      }
    }
    for (const anchor of Array.from(document.querySelectorAll('a:not([href])'))) {
      out.misuseButtons.push(`${sk.describe(anchor)} is a link with no destination`);
    }

    // 43 / 44 / 45 / 47 / 48 / 49 / 50 — forms.
    const emailish = /mail|e-mail/i;
    const telish = /phone|tel|mobile/i;

    for (const control of Array.from(document.querySelectorAll('input, select, textarea')).filter(sk.isVisible)) {
      const type = (control.getAttribute('type') || '').toLowerCase();
      const identity = `${control.getAttribute('name') || ''} ${control.id || ''} ${sk.accessibleName(control)}`;
      const required = control.hasAttribute('required') || 'true' === control.getAttribute('aria-required');

      if (required) {
        const label = sk.accessibleName(control);
        const marked = /[*]|\(required\)|required/i.test(label) || /required/.test(control.className || '');
        if (!marked) out.requiredUnmarked.push(sk.describe(control));
      }

      if (emailish.test(identity) && 'text' === type) {
        out.inputTypes.push(`${sk.describe(control)} looks like an email address but is type="text"`);
      }
      if (telish.test(identity) && 'text' === type) {
        out.inputTypes.push(`${sk.describe(control)} looks like a phone number but is type="text"`);
      }
      if (emailish.test(identity) && 'email' === type && !control.getAttribute('autocomplete')) {
        out.autocomplete.push(sk.describe(control));
      }
      if (telish.test(identity) && 'tel' === type && !control.getAttribute('autocomplete')) {
        out.autocomplete.push(sk.describe(control));
      }
    }

    for (const fieldset of Array.from(document.querySelectorAll('fieldset'))) {
      if (!fieldset.querySelector('legend')) out.fieldsets.push('fieldset without a legend');
    }
    for (const control of Array.from(document.querySelectorAll('input[type="radio"]'))) {
      if (control.closest('fieldset') || !control.name) continue;
      const group = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(control.name)}"]`);
      if (group.length > 1) out.fieldsets.push(`radio group "${control.name}" has no fieldset and legend`);
    }

    for (const form of Array.from(document.querySelectorAll('form'))) {
      const wired =
        !!form.querySelector('[role="alert"], .error, [aria-invalid], [aria-describedby]') ||
        form.hasAttribute('novalidate');
      if (!wired) out.errorWiring.push(`${sk.describe(form)} has nowhere to show an error`);

      for (const node of Array.from(form.querySelectorAll('[role="alert"], .error'))) {
        const text = (node.textContent || '').trim();
        if (text && text.length < 8) out.vagueErrors.push(`"${text}"`);
      }
    }

    const submits = document.querySelectorAll('button[type="submit"], input[type="submit"]');
    if (submits.length > 0) {
      const handled = document.querySelectorAll('[aria-busy], [aria-live], [disabled][data-loading], .loading, .spinner').length > 0;
      if (!handled) out.busyStates.push(`${submits.length} submit control(s) with no busy or loading state`);
    }

    // 53 / 54 / 55 — media semantics.
    for (const video of Array.from(document.querySelectorAll('video'))) {
      if (!video.querySelector('track[kind="captions"], track[kind="subtitles"]')) out.videos.push(sk.describe(video));
    }

    for (const audio of Array.from(document.querySelectorAll('audio'))) {
      const described = audio.getAttribute('aria-describedby');
      const sibling = audio.nextElementSibling;
      const nearTranscript = sibling && /transcript/i.test(sibling.textContent || '');
      if (!described && !nearTranscript) out.audios.push(sk.describe(audio));
    }

    for (const svg of Array.from(document.querySelectorAll('svg'))) {
      const decorative = 'true' === svg.getAttribute('aria-hidden') || 'presentation' === svg.getAttribute('role');
      const labelled = !!svg.querySelector('title') || !!svg.getAttribute('aria-label') || !!svg.getAttribute('aria-labelledby');
      if (!decorative && !labelled && svg.getBoundingClientRect().width > 0) out.svgs.push(sk.describe(svg));
    }

    // 63 / 64 / 66 / 67 / 68 / 69 — metadata.
    out.metaViewport = (document.querySelector('meta[name="viewport"]') || {}).content || '';
    out.metaDescription = ((document.querySelector('meta[name="description"]') || {}).content || '').trim();
    out.canonical = (document.querySelector('link[rel="canonical"]') || {}).href || '';

    for (const tag of ['og:title', 'og:description', 'og:image', 'og:url', 'og:type', 'twitter:card']) {
      if (!document.querySelector(`meta[property="${tag}"], meta[name="${tag}"]`)) out.ogMissing.push(tag);
    }

    for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        JSON.parse(script.textContent || '');
      } catch (error) {
        out.jsonLd.push(String((error && error.message) || error).slice(0, 80));
      }
    }

    return out;
  });

  const where = meta.path;

  report.add(8, found.lightContrast.length === 0, `${found.lightContrast.length} text element(s) below AA`, where);
  report.add(13, found.lightContrast.length === 0, found.lightContrast.slice(0, MAX_OFFENDERS).map((item) => `${item.el} ${item.ratio}:1 (needs ${item.required}:1)`).join('; '), where);
  report.add(9, found.interactiveContrast.length === 0, found.interactiveContrast.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(11, found.colourAlone.length === 0, found.colourAlone.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(14, found.missingAlt.length === 0, found.missingAlt.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(51, found.brokenImages.length === 0, found.brokenImages.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(52, found.unsizedImages.length === 0, found.unsizedImages.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(56, found.lazyImages.length === 0, found.lazyImages.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(15, found.unlabelledControls.length === 0, found.unlabelledControls.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(16, found.namelessControls.length === 0, found.namelessControls.slice(0, MAX_OFFENDERS).join('; '), where);

  const h1s = found.headings.filter((heading) => 1 === heading.level);
  const hierarchy = [];
  if (1 !== h1s.length) hierarchy.push(`${h1s.length} h1 elements, expected exactly 1`);

  let previous = 0;
  for (const heading of found.headings) {
    if (previous && heading.level > previous + 1) {
      hierarchy.push(`h${previous} is followed by h${heading.level} at ${heading.el}`);
    }
    previous = heading.level;
  }
  report.add(17, hierarchy.length === 0, hierarchy.slice(0, MAX_OFFENDERS).join('; '), where);

  report.add(18, found.landmarks.main && found.landmarks.nav && 1 === found.landmarks.mains, `main=${found.landmarks.main} nav=${found.landmarks.nav} mainCount=${found.landmarks.mains}`, where);
  report.add(19, found.skipLink, 'there is no skip-to-content link', where);
  report.add(20, found.unreachable.length === 0, found.unreachable.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(21, 0 === found.positiveTabindex, `${found.positiveTabindex} positive tabindex value(s)`, where);
  report.add(22, found.badAria.length === 0, found.badAria.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(23, found.tables.length === 0, found.tables.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(24, found.lists.length === 0, found.lists.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(25, found.frames.length === 0, found.frames.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(26, found.scrollables.length === 0, found.scrollables.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(28, 0 === found.duplicateIds.length, Array.from(new Set(found.duplicateIds)).slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(29, '' !== found.lang, `html lang="${found.lang}"`, where);
  report.add(30, 0 === found.placeholderText.length, found.placeholderText.join('; '), where);
  report.add(31, Object.keys(found.fontFamilies).length <= 3 && Object.keys(found.fontSizes).length <= 14, `${Object.keys(found.fontFamilies).length} font families, ${Object.keys(found.fontSizes).length} size/weight combinations`, where);
  report.add(32, 0 === found.tightLineHeight.length, found.tightLineHeight.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(33, 0 === found.fixedHeightOverflow.length, found.fixedHeightOverflow.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(34, 0 === found.strandedHeadings.length, found.strandedHeadings.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(35, 0 === found.vagueLinks.length, found.vagueLinks.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(36, 0 === found.shoutyText.length, found.shoutyText.slice(0, MAX_OFFENDERS).join('; '), where);

  meta.navLinks = found.navLinks;

  const unsafeExternal = found.externalLinks.filter(
    (link) => '_blank' === link.target && !/noopener/.test(link.rel),
  );
  report.add(41, 0 === unsafeExternal.length, unsafeExternal.slice(0, MAX_OFFENDERS).map((link) => `${link.href} opens a new tab without rel="noopener"`).join('; '), where);
  report.add(42, 0 === found.misuseButtons.length, found.misuseButtons.slice(0, MAX_OFFENDERS).join('; '), where);

  report.add(43, 0 === found.requiredUnmarked.length, found.requiredUnmarked.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(44, 0 === found.errorWiring.length, found.errorWiring.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(45, 0 === found.vagueErrors.length, found.vagueErrors.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(47, 0 === found.busyStates.length, found.busyStates.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(48, 0 === found.inputTypes.length, found.inputTypes.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(49, 0 === found.autocomplete.length, found.autocomplete.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(50, 0 === found.fieldsets.length, found.fieldsets.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(53, 0 === found.videos.length, found.videos.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(54, 0 === found.audios.length, found.audios.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(55, 0 === found.svgs.length, found.svgs.slice(0, MAX_OFFENDERS).join('; '), where);

  report.add(63, /width\s*=\s*device-width/i.test(found.metaViewport), found.metaViewport || 'there is no meta viewport tag', where);
  const hasTitle = '' !== found.title;
  const hasDescription = '' !== found.metaDescription;
  report.add(64, hasTitle && hasDescription, `title="${hasTitle ? found.title : 'missing'}", description ${hasDescription ? 'present' : 'missing'}`, where);
  report.add(66, hasDescription, 'no meta description', where);
  report.add(67, 0 === found.ogMissing.length, `missing ${found.ogMissing.slice(0, MAX_OFFENDERS).join(', ')}`, where);
  report.add(68, '' !== found.canonical, 'no canonical link', where);
  report.add(69, 0 === found.jsonLd.length, found.jsonLd.slice(0, MAX_OFFENDERS).join('; '), where);

  // 75 — mixed content can only exist on a secure page.
  if ('https:' === meta.protocol) {
    report.add(75, 0 === found.insecureResources.length, found.insecureResources.slice(0, MAX_OFFENDERS).join('; '), where);
  } else {
    report.skip(75, 'This page was served over plain HTTP, so there is nothing to mix.');
  }

  // A javascript: URL is not mixed content — it belongs with unsanitised input.
  report.add(78, 0 === found.rawHrefProtocols.length, found.rawHrefProtocols.slice(0, MAX_OFFENDERS).map((href) => `href="${href}" is a javascript: URL`).join('; '), where);

  meta.title = found.title;
  meta.hasDescription = hasDescription;
  meta.navSignature = found.navSignature;
  meta.hasBreadcrumb = found.hasBreadcrumb;
  meta.links = found.internalLinks.map((link) => link.href);
  meta.internalUrls = found.internalLinks.map((link) => link.absolute);
  meta.depth = new URL(meta.url).pathname.split('/').filter(Boolean).length;
}

// Focus visibility needs the real :focus state, so it runs as its own pass.
async function passFocusVisibility(page, report, meta) {
  const problems = await page.evaluate(() => {
    const sk = window.__sk;
    const fingerprint = (element) => {
      const style = getComputedStyle(element);
      return [
        style.outlineStyle,
        style.outlineWidth,
        style.outlineColor,
        style.boxShadow,
        style.borderColor,
        style.borderWidth,
        style.backgroundColor,
      ].join('|');
    };

    const out = [];

    for (const element of sk.visibleInteractives().slice(0, 40)) {
      const before = fingerprint(element);
      element.focus();
      const active = document.activeElement === element;
      const after = fingerprint(element);
      element.blur();

      if (!active || before === after) {
        const style = getComputedStyle(element);
        const suppressed = 'none' === style.outlineStyle && 'none' === style.boxShadow;
        out.push(`${sk.describe(element)}${suppressed ? ' — outline removed with nothing in its place' : ' — no visible change on focus'}`);
      }
    }

    return out;
  });

  report.add(10, 0 === problems.length, problems.slice(0, MAX_OFFENDERS).join('; '), meta.path);
}

/** Overflow, overlap, clipping, image sizing, touch targets. Once per viewport. */
async function passLayout(page, report, meta, viewport) {
  const found = await page.evaluate(() => {
    const sk = window.__sk;
    const out = {
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      clipped: [],
      overlapping: [],
      oversizedImages: [],
      smallTargets: [],
      fixedWidth: [],
    };

    for (const element of Array.from(document.querySelectorAll('body *')).filter(sk.isVisible)) {
      const style = getComputedStyle(element);
      const className = typeof element.className === 'string' ? element.className : '';
      const intentional =
        'ellipsis' === style.textOverflow ||
        'none' !== style.webkitLineClamp ||
        /truncate|line-clamp|no-scrollbar/.test(className);

      // 3 — clipped by an overflow:hidden box that does not look deliberate.
      if ('hidden' === style.overflow && !intentional) {
        if (element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2) {
          out.clipped.push(sk.describe(element));
        }
      }

      // 5 — a hard pixel width cannot adapt to a narrower screen.
      if (/px$/.test(style.width) && parseFloat(style.width) > 360 && 'fixed' !== style.position) {
        out.fixedWidth.push(`${sk.describe(element)} is fixed at ${style.width}`);
      }
    }

    // 2 — overlapping structural regions (the previous checker's rule, kept).
    const regions = ['header', 'main', 'footer', 'nav'].flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).map((element) => ({ selector, element })),
    );

    for (let i = 0; i < regions.length; i += 1) {
      for (let j = i + 1; j < regions.length; j += 1) {
        const a = regions[i];
        const b = regions[j];
        if (a.element.contains(b.element) || b.element.contains(a.element)) continue;

        const ra = a.element.getBoundingClientRect();
        const rb = b.element.getBoundingClientRect();
        if (0 === ra.width || 0 === rb.width) continue;

        const overlapX = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
        const overlapY = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));

        if (overlapX * overlapY > 0.25 * Math.min(ra.width * ra.height, rb.width * rb.height)) {
          out.overlapping.push(`${a.selector} over ${b.selector}`);
        }
      }
    }

    // 4 — images spilling out of their parent, or blown far past native size.
    for (const image of Array.from(document.images).filter(sk.isVisible)) {
      const rect = image.getBoundingClientRect();
      const parent = image.parentElement;

      if (parent) {
        const parentRect = parent.getBoundingClientRect();
        if (rect.right > parentRect.right + 2 || rect.left < parentRect.left - 2) {
          out.oversizedImages.push(sk.describe(image));
          continue;
        }
      }

      if (image.naturalWidth > 0 && rect.width > image.naturalWidth * 1.5 && rect.width > 320) {
        out.oversizedImages.push(`${sk.describe(image)} drawn at ${Math.round(rect.width)}px from ${image.naturalWidth}px native`);
      }
    }

    // 6 — 44x44 minimum, exempting links inside a sentence.
    for (const element of sk.visibleInteractives()) {
      const rect = element.getBoundingClientRect();
      if (0 === rect.width || 0 === rect.height) continue;
      if (rect.width >= 44 && rect.height >= 44) continue;
      if (sk.inSentence(element)) continue;
      out.smallTargets.push(`${sk.describe(element)} is ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }

    return out;
  });

  const where = `${meta.path} (${viewport.width}px)`;

  report.add(1, !found.overflowX, `content is ${found.scrollWidth}px wide in a ${found.clientWidth}px viewport`, where);
  report.add(2, 0 === found.overlapping.length, found.overlapping.slice(0, MAX_OFFENDERS).join('; '), where);
  report.add(3, 0 === found.clipped.length, found.clipped.slice(0, MAX_OFFENDERS).join('; '), where);

  if ('zoom200' === viewport.name) {
    report.add(7, !found.overflowX && 0 === found.clipped.length, found.overflowX ? `content is ${found.scrollWidth}px wide at 200% zoom` : found.clipped.slice(0, MAX_OFFENDERS).join('; '), where);
  }

  if ('mobile' === viewport.name) {
    report.add(4, 0 === found.oversizedImages.length, found.oversizedImages.slice(0, MAX_OFFENDERS).join('; '), where);
    report.add(5, 0 === found.fixedWidth.length, found.fixedWidth.slice(0, MAX_OFFENDERS).join('; '), where);
    report.add(6, 0 === found.smallTargets.length, found.smallTargets.slice(0, MAX_OFFENDERS).join('; '), where);
  }
}

/** 12 — contrast with a dark colour scheme forced on. */
async function passDarkScheme(browser, report, meta) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });

  try {
    const page = await context.newPage();
    await page.goto(meta.url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.evaluate(installHelpers);

    const failures = await page.evaluate(() => {
      const sk = window.__sk;
      const out = [];

      for (const element of sk.textElements()) {
        const style = getComputedStyle(element);
        const foreground = sk.parseColor(style.color);
        if (!foreground) continue;

        const background = sk.opaqueBackground(element);
        if (background.uncertain) continue;

        const size = parseFloat(style.fontSize);
        const weight = Number(style.fontWeight) || 400;
        const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
        const ratio = sk.contrast(foreground, background.color);

        if (ratio + 0.01 < required) {
          out.push(`${sk.describe(element)} ${Math.round(ratio * 100) / 100}:1 (needs ${required}:1)`);
        }
      }

      return out.slice(0, 20);
    });

    report.add(12, 0 === failures.length, failures.slice(0, MAX_OFFENDERS).join('; '), `${meta.path} (dark)`);
  } catch (error) {
    report.skip(12, `Dark mode could not be rendered: ${error.message}`);
  } finally {
    await context.close();
  }
}

/** 72 — a real phone viewport with a mobile user agent. */
async function passMobileDevice(browser, report, meta) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });

  try {
    const page = await context.newPage();
    await page.goto(meta.url, { waitUntil: 'networkidle', timeout: 30000 });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );

    report.add(72, !overflow, overflow ? 'the page scrolls sideways on a 390px iPhone viewport' : '', `${meta.path} (iPhone)`);
  } catch (error) {
    report.skip(72, `The phone viewport could not be rendered: ${error.message}`);
  } finally {
    await context.close();
  }
}

/** 900 — axe-core, for the WCAG rules a hand-written heuristic will miss. */
async function passAxe(page, report, meta) {
  try {
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const serious = violations.filter((violation) => ['critical', 'serious'].includes(violation.impact));

    report.add(
      900,
      0 === serious.length,
      serious.slice(0, MAX_OFFENDERS).map((violation) => `${violation.id} (${violation.nodes.length})`).join(', '),
      meta.path,
    );
  } catch (error) {
    report.skip(900, `axe-core could not run: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Static source scans: 27, 73, 74, 77, 78 — impossible from the DOM.
// ---------------------------------------------------------------------------

function passSource(workspaceRoot, report) {
  const files = [];
  const skipped = [];

  const walk = (directory, depth = 0) => {
    if (depth > 6) return;

    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (['node_modules', '.git', 'dist', '.builder'].includes(entry.name)) continue;

      const full = join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (['.js', '.jsx', '.ts', '.tsx', '.css', '.html', '.mjs'].includes(extname(entry.name))) {
        files.push(full);
      }
    }
  };

  walk(workspaceRoot);

  const ids = [27, 73, 74, 77, 78];

  if (0 === files.length) {
    for (const id of ids) skipped.push(id);
  }

  const needsPrefix = [];
  const modernFeatures = [];
  const rawHtml = [];
  const userInput = [];
  const animations = [];
  let respectsReducedMotion = false;

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const relative = file.startsWith(workspaceRoot) ? file.slice(workspaceRoot.length + 1) : file;
    const lines = text.split('\n');

    if (/prefers-reduced-motion/.test(text)) respectsReducedMotion = true;

    lines.forEach((line, index) => {
      const at = `${relative}:${index + 1}`;

      // 73 — autoprefixer only reaches stylesheets, so inline styles and JSX
      // style objects need the prefixed property written out by hand. JSX uses
      // camelCase, so both spellings have to be looked for.
      if (/style=\{\{|style=\{|style="/.test(line)) {
        for (const property of ['backdrop-filter', 'user-select', 'appearance', 'text-size-adjust']) {
          const camel = property.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          const plain = new RegExp(`(^|[;{,\\s])${property}\\s*:`).test(line)
            || new RegExp(`(^|[{,\\s])${camel}\\s*:`).test(line);
          const prefixed = new RegExp(`-webkit-${property}|-moz-${property}|-ms-${property}|Webkit${camel}`).test(line);
          if (plain && !prefixed) needsPrefix.push(`${at} uses ${property} with no prefixed fallback`);
        }
      }

      // 74 — a modern function or selector with no fallback declaration above it.
      const previous = lines[index - 1] || '';
      for (const feature of ['oklch(', 'color-mix(', ':has(', 'text-wrap:balance', 'field-sizing']) {
        if (line.includes(feature) && !/#[0-9a-f]{3,8}|rgb\(|@supports|fallback/i.test(previous)) {
          modernFeatures.push(`${at} uses ${feature} with no fallback`);
        }
      }

      // 27 — real motion, not a 150ms colour transition.
      if (/@keyframes|(^|[^-])animation\s*:|animate-(?!none)\w+/.test(line)) animations.push(at);

      // 77 — raw HTML sinks.
      if (/dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML|document\.write|eval\(|new Function\(/.test(line)) {
        rawHtml.push(`${at} ${line.trim().slice(0, 90)}`);
      }

      // 78 — reading user-controlled input.
      if (/location\.(search|hash)|URLSearchParams|document\.referrer/.test(line)) userInput.push(at);
    });
  }

  if (skipped.length) {
    for (const id of skipped) report.skip(id, 'No project source was found to scan.');
    return;
  }

  report.add(73, 0 === needsPrefix.length, needsPrefix.slice(0, MAX_OFFENDERS).join('; '));
  report.add(74, 0 === modernFeatures.length, modernFeatures.slice(0, MAX_OFFENDERS).join('; '));
  report.add(27, 0 === animations.length || respectsReducedMotion, animations.length && !respectsReducedMotion ? `${animations.length} animated element(s) and no prefers-reduced-motion query anywhere in the source` : '');
  report.add(77, 0 === rawHtml.length, rawHtml.slice(0, MAX_OFFENDERS).join('; '));
  report.add(78, 0 === rawHtml.length || 0 === userInput.length, rawHtml.length && userInput.length ? `reads user input at ${userInput.slice(0, 3).join(', ')} and writes raw HTML` : '');
}

// ---------------------------------------------------------------------------
// Crawl and cross-page checks
// ---------------------------------------------------------------------------

const shortPath = (url, base) => {
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(base).origin
      ? parsed.pathname + parsed.search
      : parsed.href;
  } catch {
    return url;
  }
};

async function crawlPage(browser, entryUrl, url, report) {
  const meta = {
    url,
    path: shortPath(url, entryUrl),
    protocol: new URL(url).protocol,
    status: 'checked',
    links: [],
    internalUrls: [],
  };

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const consoleErrors = [];
  const consoleWarnings = [];
  const failedRequests = [];
  const requested = [];

  const page = await context.newPage();
  page.on('console', (message) => {
    const text = message.text();
    // The browser logs a console error for every failed request. Check 58 owns
    // that, so counting it here too would report one defect twice.
    if (message.type() === 'error' && !/Failed to load resource/i.test(text)) consoleErrors.push(text);
    else if (message.type() === 'warning') consoleWarnings.push(text);
  });
  page.on('pageerror', (error) => consoleErrors.push(String((error && error.message) || error)));
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    failedRequests.push(`${request.url()} (${failure ? failure.errorText : 'failed'})`);
  });
  page.on('response', (response) => {
    requested.push(response.url());
    if (response.status() >= 400) failedRequests.push(`${response.url()} returned ${response.status()}`);
  });

  try {
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    const httpStatus = response ? response.status() : 0;
    meta.httpStatus = httpStatus;

    // A link that 404s is already reported by checks 40 and 58. Running the
    // whole suite over the error page would add dozens of findings about a
    // document nobody will ever publish, so stop here.
    if (httpStatus >= 400) {
      meta.status = 'failed';
      meta.detail = `HTTP ${httpStatus}`;
      report.add(58, false, `${meta.path} returned ${httpStatus}`, meta.path);
      return meta;
    }

    await page.waitForTimeout(300);
    await page.evaluate(installHelpers);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(120);

      if ('desktop' === viewport.name) {
        await passDesktop(page, report, meta);
        await passFocusVisibility(page, report, meta);
        await passAxe(page, report, meta);
      } else {
        await passLayout(page, report, meta, viewport);
      }
    }

    await passMobileDevice(browser, report, meta);
    await passDarkScheme(browser, report, meta);

    report.add(57, 0 === consoleErrors.length, consoleErrors.slice(0, MAX_OFFENDERS).join(' | '), meta.path);
    report.add(61, 0 === consoleWarnings.length, consoleWarnings.slice(0, MAX_OFFENDERS).join(' | '), meta.path);
    report.add(58, 0 === failedRequests.length, failedRequests.slice(0, MAX_OFFENDERS).join(' | '), meta.path);
    report.add(62, new Set(requested).size === requested.length, 'the same asset was requested more than once', meta.path);
  } catch (error) {
    report.add(57, false, `the page could not be loaded: ${error.message}`, meta.path);
    meta.status = 'failed';
    meta.detail = error.message;
  } finally {
    await context.close();
  }

  return meta;
}

async function passCrossPage(report, pages, linkStatus) {
  const checked = pages.filter((page) => 'checked' === page.status);

  // 65 — titles must be unique across the site.
  const titles = new Map();
  for (const page of checked) {
    if (!page.title) continue;
    const key = page.title.trim().toLowerCase();
    if (!titles.has(key)) titles.set(key, []);
    titles.get(key).push(page.path);
  }
  const duplicateTitles = Array.from(titles.values()).filter((paths) => paths.length > 1);
  report.add(65, 0 === duplicateTitles.length, duplicateTitles.slice(0, MAX_OFFENDERS).map((paths) => `used by ${paths.join(' and ')}`).join('; '));

  // 37 — one navigation across the whole site.
  const signatures = new Map();
  for (const page of checked) {
    if (!page.navSignature) continue;
    if (!signatures.has(page.navSignature)) signatures.set(page.navSignature, []);
    signatures.get(page.navSignature).push(page.path);
  }
  if (signatures.size > 1) {
    const groups = Array.from(signatures.values()).map((paths) => paths.join(', '));
    report.add(37, false, `navigation differs between ${groups.slice(0, 3).join(' | ')}`);
  } else {
    report.add(37, true, 'navigation is identical on every page');
  }

  // 38 — a nav with more than one destination has to say which page you are on.
  // On a single-page site there is nothing to indicate, so it does not apply.
  const withNav = checked.filter((page) => (page.navLinks || []).length > 1);

  if (checked.length <= 1) {
    report.skip(38, 'This is a single-page site, so there is no other page to indicate.');
  } else if (0 === withNav.length) {
    report.skip(38, 'No page has a navigation with more than one destination.');
  } else {
    const unmarked = withNav.filter(
      (page) => !page.navLinks.some((link) => ['page', 'true'].includes(link.current)),
    );
    report.add(38, 0 === unmarked.length, unmarked.slice(0, MAX_OFFENDERS).map((page) => page.path).join('; '));
  }

  // 39 — a page more than one level deep should say where it is.
  const deep = checked.filter((page) => page.depth >= 1);
  if (0 === deep.length) {
    report.skip(39, 'This is a single-page site, so there are no deep pages to breadcrumb.');
  } else {
    const without = deep.filter((page) => !page.hasBreadcrumb);
    report.add(39, 0 === without.length, without.slice(0, MAX_OFFENDERS).map((page) => page.path).join('; '));
  }

  // 40 — every internal link must resolve, including links inside collapsed menus.
  const broken = Array.from(linkStatus.entries()).filter(([, status]) => status >= 400 || 0 === status);
  report.add(40, 0 === broken.length, broken.slice(0, MAX_OFFENDERS).map(([href, status]) => `${href} returned ${0 === status ? 'no response' : status}`).join('; '));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const START = '__SITE_CHECK_START__';
const END = '__SITE_CHECK_END__';

const argv = process.argv.slice(2);
const entryUrl = argv.find((argument) => !argument.startsWith('--')) || 'http://127.0.0.1:3000';
const budgetFlag = argv.find((argument) => argument.startsWith('--budget='));
const budgetSeconds = Number((budgetFlag ? budgetFlag.split('=')[1] : process.env.SITE_CHECK_BUDGET_SECONDS) || 240);
const workspaceRoot = process.env.SITE_CHECK_WORKSPACE || '/workspace';
const deadline = Date.now() + budgetSeconds * 1000;

const report = new Report();
const pages = [];
const linkStatus = new Map();
let truncated = false;
let browser = null;

try {
  passSource(workspaceRoot, report);

  browser = await chromium.launch({ args: ['--no-sandbox'] });

  const queue = [entryUrl];
  const seen = new Set();

  while (queue.length > 0) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }

    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    const page = await crawlPage(browser, entryUrl, url, report);
    pages.push(page);

    for (const link of page.internalUrls) {
      const resolved = new URL(link);
      if (resolved.hash) continue;
      if (seen.has(link) || queue.includes(link)) continue;
      queue.push(link);
    }
  }

  // A link inside a collapsed menu was never rendered, so it is never crawled.
  // Request every internal href directly so a dead one is still caught.
  const context = await browser.newContext();

  for (const page of pages) {
    for (const href of page.links) {
      let absolute = null;
      try {
        absolute = new URL(href, entryUrl).href;
      } catch {
        continue;
      }

      if (linkStatus.has(absolute)) continue;

      try {
        const response = await context.request.get(absolute, { timeout: 15000, maxRedirects: 3 });
        linkStatus.set(absolute, response.status());
      } catch {
        linkStatus.set(absolute, 0);
      }
    }
  }

  await context.close();
  passCrossPage(report, pages, linkStatus);
} catch (error) {
  report.checkerError('checker', error);
} finally {
  if (browser) await browser.close().catch(() => {});
}

// A checker that crashed must never look like a clean bill of health.
if (0 < report.checkerErrors.length) {
  report.add(57, false, 'the checker itself failed, so nothing could be verified', 'checker');
}

const summary = report.summary();
const output = {
  ok: 0 === summary.blocking,
  entry: entryUrl,
  truncated,
  pages: pages.map((page) => ({
    path: page.path,
    status: page.status,
    http_status: page.httpStatus || null,
    title: page.title || null,
    detail: page.detail || null,
  })),
  checker_errors: report.checkerErrors,
  ...report.toJSON(),
};

console.log(START);
console.log(JSON.stringify(output, null, 2));
console.log(END);

process.exit(output.ok ? 0 : 1);