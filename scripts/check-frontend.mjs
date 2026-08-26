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

// Data-load contract: district_coords.json is locked down as a static file on the
// Node server, so COORDS must come from the API first. The API request must be
// issued before any ./data/district_coords.json fetch, and api.coords must feed
// COORDS. The static file is only a fallback (API-off / older build).
{
  const apiAt = app.indexOf("fetchJson('/api/startups')");
  const staticCoordsAt = app.indexOf("fetchJson('./data/district_coords.json')");
  check(apiAt !== -1, 'app.js must fetch /api/startups');
  check(app.includes('api.coords'), 'app.js must read district centroids from api.coords');
  check(
    staticCoordsAt === -1 || apiAt < staticCoordsAt,
    'app.js must request /api/startups before fetching ./data/district_coords.json (API-first ordering)'
  );
}

// Security: external links must use rel="noopener noreferrer"; no raw noopener-only.
check(app.includes('rel="noopener noreferrer"'), 'app.js external links must use rel="noopener noreferrer"');
check(!/rel="noopener"[^\s]/.test(app), 'found a bare rel="noopener" without noreferrer');
check(app.includes('function escapeHtml'), 'app.js missing escapeHtml (XSS guard)');
check(!/\beval\(/.test(app) && !/new Function\(/.test(app), 'app.js must not use eval / Function constructor');

// Frontend safety polish: the popup data-id must be escaped like all dynamic content.
check(/data-id="\$\{escapeHtml\(s\.id\)\}"/.test(app), 'popup data-id must be escaped (escapeHtml(s.id))');

// Accessibility: list cards must be keyboard-selectable (role=button/tabindex=0/Enter+Space).
check(/setAttribute\('role', 'button'\)/.test(app), 'list cards must set role="button"');
check(/setAttribute\('tabindex', '0'\)/.test(app), 'list cards must be focusable (tabindex="0")');
check(/addEventListener\('keydown'/.test(app), 'list cards must handle keydown');
check(/e\.key === 'Enter'/.test(app), 'list cards must handle the Enter key');
check(/e\.key === ' '/.test(app), 'list cards must handle the Space key');
// Enter opens the detail drawer -> a keyboard-accessible way that does not rely on double-click.
check(/e\.key === 'Enter'[\s\S]{0,80}openDetail/.test(app), 'Enter on a card must open the detail drawer');

// Accessibility: the popup "Full details" control must be a real (keyboard-accessible) button.
check(/<button type="button" class="popup-more"/.test(app), 'popup "Full details" must be a real <button>');

// Key behaviours present.
check(app.includes('function verifyStartup'), 'app.js missing verifyStartup');
check(app.includes('function submitStartup'), 'app.js missing submitStartup');
check(app.includes('function insertRecord'), 'app.js missing insertRecord (live update)');
check(app.includes('function toast'), 'app.js missing toast helper');

// After a community add, the district's count changes, so every marker in the
// affected district must have its count-based radius refreshed — not just the
// new pin. Assert the refresh helper exists and that insertRecord calls it.
check(app.includes('function refreshDistrictRadii'), 'app.js must refresh marker radii for the affected district after an add');
check(/setRadius\(/.test(app), 'app.js must call marker.setRadius to resize existing markers');
check(/insertRecord[\s\S]*?refreshDistrictRadii\(/.test(app), 'insertRecord must call refreshDistrictRadii after inserting the new record');

// CSS hooks.
check(css.includes('.toast'), 'style.css missing .toast styles');
check(css.includes('.modal'), 'style.css missing .modal styles');

if (failures.length) {
  console.error('Frontend check FAILED:');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`Frontend check passed — ${requiredIds.length} IDs + endpoints + security attrs OK.`);
