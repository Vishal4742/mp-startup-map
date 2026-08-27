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

// Comment-free view of app.js, built in one token-aware pass: string and
// template literals are kept verbatim (so a `//` or `/*` inside them never
// opens a comment), block comments and `//`-to-end-of-line are removed. Checks
// about "what the code does" run on this so commented-out code cannot satisfy them.
const stripComments = (src) => src.replace(
  /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
  '$1'
);
const code = stripComments(app);

// Body of a top-level function declaration: from `function NAME(` at column 0
// to the first column-0 `}` that is followed by a blank line, EOF or another
// top-level declaration — so a `}` inside a template literal does not end it.
const fnBody = (name) => {
  const m = code.match(new RegExp(
    '^(?:async\\s+)?function ' + name + '\\([\\s\\S]*?\\n\\}(?=\\n(?:\\n|$|async |function |const |let |class |\\())',
    'm'
  ));
  return m ? m[0] : '';
};

// Required element IDs in index.html.
const requiredIds = [
  'map', 'search', 'filter-district', 'filter-industry', 'filter-sector', 'filter-contacts', 'toggle-list', 'pane-list', 'toggle-filters', 'filters',
  'add-startup', 'add-modal', 'modal-backdrop', 'add-form', 'verify-btn',
  'submit-btn', 'verify-result', 'toast-region',
  'f-name', 'f-dipp', 'f-district', 'f-city', 'f-sector', 'f-industry', 'f-description',
  'f-website', 'f-email', 'f-phone', 'f-founders', 'f-linkedin', 'f-careers', 'f-sources',
];
for (const id of requiredIds) {
  check(html.includes(`id="${id}"`), `index.html missing element id="${id}"`);
}

// Accessibility / semantics.
check(/id="add-modal"[^>]*role="dialog"/.test(html), 'add modal missing role="dialog"');
check(/id="add-modal"[^>]*aria-modal="true"/.test(html), 'add modal missing aria-modal');
check(/id="detail"[^>]*role="dialog"/.test(html), 'detail drawer missing role="dialog" (same modal interaction as the add form)');
check(/id="detail"[^>]*aria-labelledby="detail-title"/.test(html), 'detail drawer must be labelled by its heading');
check(code.includes('<h2 id="detail-title">'), 'app.js must render the detail heading with id="detail-title" (aria-labelledby target)');
check(/aria-live="(polite|assertive)"/.test(html), 'missing a live aria-live region');
check(/id="toggle-list"[^>]*aria-expanded=/.test(html) && /id="toggle-list"[^>]*aria-controls="pane-list"/.test(html), 'the List toggle must expose aria-expanded and aria-controls');
check(/setAttribute\('aria-expanded'/.test(fnBody('setListOpen')), 'setListOpen must keep aria-expanded in sync');
check(/id="toggle-filters"[^>]*aria-expanded=/.test(html) && /id="toggle-filters"[^>]*aria-controls="filters"/.test(html), 'the Filters toggle must expose aria-expanded and aria-controls');
check(/setAttribute\('aria-expanded'/.test(fnBody('setFiltersOpen')), 'setFiltersOpen must keep aria-expanded in sync');
check(/<meta name="viewport" content="[^"]*width=device-width[^"]*"/.test(html), 'index.html needs a device-width viewport');
// aria-modal="true" on both overlays means Tab must be contained inside them.
check(app.includes('function containTab'), 'app.js must contain Tab focus inside aria-modal dialogs (containTab)');
check(
  /\n\s+containTab\(el\.detail\)/.test(fnBody('wireEvents')) && /\n\s+containTab\(el\.addModal\)/.test(fnBody('wireAddStartup')),
  'containTab must be attached to both the detail drawer (wireEvents) and the add modal (wireAddStartup)'
);

// Labels must state public/official-contact policy.
check(/public/i.test(html) && /not personal/i.test(html), 'form must state public/official (not personal) contact policy');

// The shared normalisation module must load before app.js (app.js reads window.MPNormalize).
{
  const sharedAt = html.indexOf('<script src="./shared/normalize.js"></script>');
  const appAt = html.indexOf('<script src="./app.js"></script>');
  check(sharedAt !== -1, 'index.html must load ./shared/normalize.js');
  check(appAt !== -1 && sharedAt < appAt, './shared/normalize.js must be loaded before ./app.js');
  check(/window\.MPNormalize/.test(app), 'app.js must take its normalisation helpers from window.MPNormalize');
}

// Endpoints referenced by the frontend.
for (const ep of ['/api/startups', '/api/startups/verify']) {
  check(app.includes(ep), `app.js missing endpoint reference ${ep}`);
}

// Data-load contract: district_coords.json is locked down as a static file on the
// Node server, so COORDS must come from the API first. The API request must be
// issued before any ./data/district_coords.json fetch, and api.coords must feed
// COORDS. The static file is only a fallback (API-off / older build).
{
  // Judge execution order inside loadData itself: the API request must be
  // awaited before any static coords fetch that appears in that body.
  const loadBody = fnBody('loadData');
  const apiHelper = fnBody('fetchApiStartups');
  check(/fetch\('\/api\/startups'\)/.test(apiHelper), 'fetchApiStartups must request /api/startups');
  const apiAt = loadBody.search(/await fetchApiStartups\(\)/);
  check(apiAt !== -1, 'loadData must await fetchApiStartups()');
  check(loadBody.includes('api.coords'), 'loadData must read district centroids from api.coords');
  // The static coords file may be fetched from loadData's fallback branch only,
  // and only after the API request.
  check(code.split('district_coords.json').length - 1 === 1, 'district_coords.json may only be referenced from loadData (static fallback)');
  const staticCoordsAt = loadBody.indexOf('district_coords.json');
  check(
    staticCoordsAt !== -1 && apiAt < staticCoordsAt,
    'loadData must request /api/startups before fetching ./data/district_coords.json (API-first ordering)'
  );
}

// Data-merge contract: the registry_gems dossier batch carries its location in
// `District` (no `City`), so the location helper must read both keys.
check(/e\.City \|\| e\.District/.test(fnBody('dossierLocation')), 'dossierLocation must read the dossier District key as well as City');

// Security: external links must use rel="noopener noreferrer"; no raw noopener-only.
check(app.includes('rel="noopener noreferrer"'), 'app.js external links must use rel="noopener noreferrer"');
check(!/rel="noopener"/.test(app), 'found a bare rel="noopener" without noreferrer');
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
// The server answers 429/403/413/415/500 with `{ error }` — never `{ duplicate }` —
// so the verify flow must branch on the HTTP status before trusting the body.
check(/\bres\.ok\b/.test(fnBody('verifyStartup')), 'verifyStartup must check res.ok before rendering the verify result');
check(app.includes('function submitStartup'), 'app.js missing submitStartup');
check(app.includes('function insertRecord'), 'app.js missing insertRecord (live update)');
check(app.includes('function toast'), 'app.js missing toast helper');

// After a community add, the district's count changes, so every marker in the
// affected district must have its count-based radius refreshed — not just the
// new pin. Assert the refresh helper exists and that insertRecord calls it.
check(app.includes('function refreshDistrictRadii'), 'app.js must refresh marker radii for the affected district after an add');
check(/setRadius\(/.test(app), 'app.js must call marker.setRadius to resize existing markers');
// Look inside the insertRecord body only (comments stripped) — a later
// `function refreshDistrictRadii(` definition must not satisfy this check.
check(/\n\s+refreshDistrictRadii\(/.test(fnBody('insertRecord')), 'insertRecord must call refreshDistrictRadii after inserting the new record');

// CSS hooks.
check(css.includes('.toast'), 'style.css missing .toast styles');
check(css.includes('.modal'), 'style.css missing .modal styles');

if (failures.length) {
  console.error('Frontend check FAILED:');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`Frontend check passed — ${requiredIds.length} IDs + endpoints + security attrs OK.`);
