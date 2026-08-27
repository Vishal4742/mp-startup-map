#!/usr/bin/env node
/*
 * Refresh the startup registry from the Startup India portal (DPIIT-recognised
 * startups), the same public directory the original data came from.
 *
 *   node scripts/fetch-startupindia.mjs                 # Madhya Pradesh, tech industries
 *   node scripts/fetch-startupindia.mjs --all           # every industry
 *   node scripts/fetch-startupindia.mjs --state "Goa"   # another state
 *   node scripts/fetch-startupindia.mjs --max-pages 5   # quick sample
 *   node scripts/fetch-startupindia.mjs --out /tmp/x.json --meta /tmp/x.meta.json
 *   node scripts/fetch-startupindia.mjs --raw-out data/registry_raw.json   # also keep the raw records
 *   node scripts/fetch-startupindia.mjs --raw-in data/registry_raw.json    # re-map without the network
 *
 * Source: POST https://api.startupindia.gov.in/sih/api/noauth/search/profiles
 * (the request the portal's own search page sends; 9 results per page). State
 * ids come from /sih/api/noauth/statesPolicy/startup/recognized/count.
 *
 * Output: data/tech_registry.json in the app's row format
 * [name, dipp_no, sector, industry, district] plus data/registry_meta.json with
 * provenance (when, from where, how many, which filter). No dependencies;
 * Node 18+ (global fetch).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { canonicalDistrict, normalizeDipp } = require(join(ROOT, 'shared', 'normalize.js'));

const API = 'https://api.startupindia.gov.in/sih/api/noauth';
const UA = 'mp-startup-map/1.0 (+https://github.com/Vishal4742/mp-startup-map)';
const PAGE_DELAY_MS = 250;   // be polite: ~4 requests/second at most
const RETRIES = 4;

// ---- args -------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const has = (name) => args.includes(name);
const STATE = flag('--state', 'Madhya Pradesh');
const OUT = flag('--out', join(ROOT, 'data', 'tech_registry.json'));
const META = flag('--meta', join(ROOT, 'data', 'registry_meta.json'));
const MAX_PAGES = Number(flag('--max-pages', 0)) || Infinity;
const ALL = has('--all');
const RAW_OUT = flag('--raw-out', '');
const RAW_IN = flag('--raw-in', '');

// ---- helpers ----------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, init = {}, attempt = 1) {
  try {
    const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) } });
    const text = await res.text();
    if (!res.ok || !text.trim().startsWith('{')) throw new Error(`HTTP ${res.status} ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
    return JSON.parse(text);
  } catch (err) {
    if (attempt >= RETRIES) throw err;
    await sleep(1000 * attempt);
    return fetchJson(url, init, attempt + 1);
  }
}

async function stateId(name) {
  const { data } = await fetchJson(`${API}/statesPolicy/startup/recognized/count`);
  const s = data.find((x) => x.state.toLowerCase() === name.toLowerCase());
  if (!s) throw new Error(`Unknown state "${name}". Known: ${data.map((x) => x.state).join(', ')}`);
  return s;
}

async function searchPage(id, page) {
  const body = {
    query: '', roles: ['Startup'], stages: [], badges: [], cities: [], states: [id],
    industries: [], sectors: [], page, dpiitRecogniseUser: true,
    internationalUser: false, is80iacExempted: false, focusSector: false,
  };
  return fetchJson(`${API}/search/profiles`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ---- main -------------------------------------------------------------
const coords = JSON.parse(await readFile(join(ROOT, 'data', 'district_coords.json'), 'utf8'));
const districts = Object.keys(coords);
// Towns that are not district names (Pithampur -> Dhar); see data/city_districts.json.
const cityDistricts = JSON.parse(await readFile(join(ROOT, 'data', 'city_districts.json'), 'utf8'));
const townIndex = new Map(Object.entries(cityDistricts).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k.toLowerCase(), v]));
function districtOf(city) {
  return canonicalDistrict(city, districts)
    || townIndex.get(String(city || '').trim().toLowerCase())
    || '';
}

// "Tech" = the industry taxonomy the curated registry already used. Pass --all
// to keep every industry instead.
let techIndustries = null;
if (!ALL) {
  try {
    const current = JSON.parse(await readFile(OUT, 'utf8'));
    techIndustries = new Set(current.map((r) => r[3]).filter(Boolean));
  } catch { techIndustries = null; }
}

// Raw records: either replayed from a snapshot (--raw-in) or fetched page by page.
const keep = (r) => ({
  id: r.id, name: r.name, dippNumber: r.dippNumber, dippRecognitionStatus: r.dippRecognitionStatus,
  city: r.city, industries: r.industries || [], sectors: r.sectors || [], stages: r.stages || [],
  registeredOn: r.registeredOn, publishedOn: r.publishedOn,
});
let state, raw = [];
if (RAW_IN) {
  const snap = JSON.parse(await readFile(RAW_IN, 'utf8'));
  state = snap.state; raw = snap.records;
  console.error(`${state.state}: replaying ${raw.length} raw records from ${RAW_IN}`);
} else {
  state = await stateId(STATE);
  console.error(`${state.state} (${state.stateId}): ${state.totalCount} recognised startups on the portal`);
  let page = 0, totalPages = 1;
  while (page < totalPages && page < MAX_PAGES) {
    const res = await searchPage(state.stateId, page);
    totalPages = res.totalPages || 0;
    for (const r of res.content || []) raw.push(keep(r));
    page++;
    if (page % 50 === 0) console.error(`  page ${page}/${totalPages} — ${raw.length} records`);
    await sleep(PAGE_DELAY_MS);
  }
  if (RAW_OUT) await writeFile(RAW_OUT, JSON.stringify({ state, fetchedAt: new Date().toISOString(), records: raw }) + '\n');
}

const byDipp = new Map();
let seen = 0, dropped = { unrecognised: 0, noDipp: 0, filtered: 0 };
const unknownCities = new Map();
for (const r of raw) {
  seen++;
  if (r.dippRecognitionStatus && r.dippRecognitionStatus !== 'RECOGNISED') { dropped.unrecognised++; continue; }
  const dipp = normalizeDipp(r.dippNumber);
  if (!/^DIPP\d+$/.test(dipp)) { dropped.noDipp++; continue; }
  const industry = (r.industries || [])[0] || '';
  const sector = (r.sectors || [])[0] || '';
  if (techIndustries && !techIndustries.has(industry)) { dropped.filtered++; continue; }
  const city = String(r.city || '').trim();
  const district = districtOf(city);
  if (city && !district) unknownCities.set(city, (unknownCities.get(city) || 0) + 1);
  if (!byDipp.has(dipp)) byDipp.set(dipp, [String(r.name || '').trim(), dipp, sector, industry, district]);
}

const rows = [...byDipp.values()].sort((a, b) => (a[4] || '~').localeCompare(b[4] || '~', 'en') || a[0].localeCompare(b[0], 'en', { sensitivity: 'base' }));
const perDistrict = {};
for (const r of rows) perDistrict[r[4] || 'Unknown'] = (perDistrict[r[4] || 'Unknown'] || 0) + 1;

await writeFile(OUT, JSON.stringify(rows, null, 1) + '\n');
await writeFile(META, JSON.stringify({
  source: `${API}/search/profiles`,
  state: state.state,
  stateId: state.stateId,
  fetchedAt: new Date().toISOString(),
  portalTotal: state.totalCount,
  scanned: seen,
  kept: rows.length,
  filter: techIndustries ? { industries: [...techIndustries].sort() } : 'all',
  dropped,
  perDistrict,
  unknownCities: Object.fromEntries([...unknownCities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)),
}, null, 2) + '\n');
console.error(`kept ${rows.length} of ${seen} scanned (${JSON.stringify(dropped)}); wrote ${OUT}`);
console.error(`unmapped cities: ${[...unknownCities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c, n]) => `${c}×${n}`).join(', ')}`);
