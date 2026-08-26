#!/usr/bin/env node
/*
 * Lightweight frontend contract check — no browser, no deps.
 * Verifies that index.html and app.js still contain the IDs, endpoints and
 * security attributes the platform depends on. Exit non-zero on any miss.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFile(join(root, f), 'utf8');

const html = await read('index.html');
const app = await read('app.js');
const css = await read('style.css');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

// Required element IDs in index.html.
const requiredIds = [
  'map', 'search', 'filter-district', 'filter-sector', 'filter-contacts',
  'add-startup', 'add-modal', 'modal-backdrop', 'add-form', 'verify-btn',
  'submit-btn', 'verify-result', 'toast-region',
  'f-name', 'f-dipp', 'f-district', 'f-sector', 'f-industry', 'f-description',
  'f-website', 'f-email', 'f-phone', 'f-founders', 'f-linkedin', 'f-careers', 'f-sources',
];
for (const id of requiredIds) {
  check(html.includes(`id="${id}"`), `index.html missing element id="${id}"`);
}

// Accessibility / semantics.
check(/role="dialog"/.test(html), 'add modal missing role="dialog"');
check(/aria-modal="true"/.test(html), 'add modal missing aria-modal');
check(/aria-live=/.test(html), 'missing an aria-live region');

// Labels must state public/official-contact policy.
check(/public/i.test(html) && /not personal/i.test(html), 'form must state public/official (not personal) contact policy');

// Endpoints referenced by the frontend.
for (const ep of ['/api/startups', '/api/startups/verify']) {
  check(app.includes(ep), `app.js missing endpoint reference ${ep}`);
}

// Security: external links must use rel="noopener noreferrer"; no raw noopener-only.
check(app.includes('rel="noopener noreferrer"'), 'app.js external links must use rel="noopener noreferrer"');
check(!/rel="noopener"[^\s]/.test(app), 'found a bare rel="noopener" without noreferrer');
check(app.includes('function escapeHtml'), 'app.js missing escapeHtml (XSS guard)');
check(!/\beval\(/.test(app) && !/new Function\(/.test(app), 'app.js must not use eval / Function constructor');

// Key behaviours present.
check(app.includes('function verifyStartup'), 'app.js missing verifyStartup');
check(app.includes('function submitStartup'), 'app.js missing submitStartup');
check(app.includes('function insertRecord'), 'app.js missing insertRecord (live update)');
check(app.includes('function toast'), 'app.js missing toast helper');

// CSS hooks.
check(css.includes('.toast'), 'style.css missing .toast styles');
check(css.includes('.modal'), 'style.css missing .modal styles');

if (failures.length) {
  console.error('Frontend check FAILED:');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`Frontend check passed — ${requiredIds.length} IDs + endpoints + security attrs OK.`);
