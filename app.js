'use strict';

/* ============================================================
   MP Startup Map — vanilla JS
   Data: GET /api/startups from server.js (registry + dossiers + community
         records + district centroids in one payload). When the page is served
         without the Node backend it falls back to the static files:
         data/tech_registry.json (656 rows), data/enriched.json (80 dossiers),
         data/district_coords.json (district HQ centroids), data/user_startups.json.
   ============================================================ */

const MP_CENTER = [23.5, 78.5];
const MP_ZOOM = 6;

// App state
let STARTUPS = [];          // merged, normalized records
let COORDS = {};            // district -> [lat, lng]
let DISTRICT_NAMES = [];    // coord keys, longest-first (for city scanning)
const markerById = new Map();

// -------- DOM --------
const $ = (id) => document.getElementById(id);
const el = {
  search: $('search'),
  district: $('filter-district'),
  sector: $('filter-sector'),
  contacts: $('filter-contacts'),
  reset: $('reset'),
  list: $('list'),
  empty: $('empty'),
  emptyReset: $('empty-reset'),
  listCount: $('list-count'),
  sort: $('sort'),
  loading: $('loading'),
  detail: $('detail'),
  detailBody: $('detail-body'),
  detailBackdrop: $('detail-backdrop'),
  detailClose: $('detail-close'),
  statTotal: $('stat-total'),
  statDistricts: $('stat-districts'),
  statSectors: $('stat-sectors'),
  statContacts: $('stat-contacts'),
  districtOptions: $('district-options'),
  sectorOptions: $('sector-options'),
  // Add-startup dialog
  addBtn: $('add-startup'),
  addModal: $('add-modal'),
  modalBackdrop: $('modal-backdrop'),
  addClose: $('add-close'),
  addForm: $('add-form'),
  verifyBtn: $('verify-btn'),
  submitBtn: $('submit-btn'),
  verifyResult: $('verify-result'),
  formHint: $('form-hint'),
  adminToken: $('f-admin-token'),
  toastRegion: $('toast-region'),
};

let map, clusterGroup;
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ============================================================
// Helpers
// ============================================================

// Normalisation rules shared with the server (shared/normalize.js, loaded by
// index.html before this file) so the map and the duplicate check agree on
// what "the same name / district / website" means.
const {
  normalizeName: normName,
  normalizeDipp: normDipp,
  extractUrls,
  stripUrlTokens,
  firstEmail,
  firstPhone,
  canonicalDistrict,
} = window.MPNormalize;

// Deterministic small hash -> jitter so co-located pins don't overlap.
function hashJitter(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = ((h >>> 0) % 1000) / 1000 - 0.5;
  const b = (((h >>> 10) >>> 0) % 1000) / 1000 - 0.5;
  return [a * 0.09, b * 0.09]; // ~±0.045deg
}

// Placeholder text the dossiers use for an unavailable field ("Not publicly
// listed (…)", "n/a (company defunct)", "Not applicable", "No active website
// found …"). Anything else is rendered as a real value.
const MISSING_RE = /^(?:not (?:publicly |yet )?(?:listed|found|available|applicable|promoted|disclosed)|n\/a\b|na(?:$|\s*\()|none(?:$|\s*\()|no active|[—–-]$)/;
function isMissing(v) {
  if (!v) return true;
  const t = String(v).trim().toLowerCase();
  return t === '' || MISSING_RE.test(t);
}

// First linkable website in a free-text field: an http(s) URL as written, else
// a bare domain promoted to https://.
function firstUrl(s) {
  return extractUrls(s)[0] || null;
}

// A dossier may name a domain while saying it no longer works ("… domain is
// DEAD (NXDOMAIN)", "twistmobile.in (site unreachable)"). Never link those. The
// annotation is judged with the URL/domain token blanked out, so a site that
// merely contains one of the words (dead-simple.io) still links.
const DEAD_SITE_RE = /\b(?:dead|nxdomain|unreachable|defunct)\b/i;
function websiteUrl(v) {
  if (isMissing(v)) return null;
  const url = firstUrl(v);
  if (!url) return null;
  return DEAD_SITE_RE.test(stripUrlTokens(v)) ? null : url;
}

function telHref(phone) {
  return 'tel:' + String(phone).replace(/[^\d+]/g, '');
}

// "Has contacts" means at least one public channel we can actually link to
// (website, email or phone). The same rule applies to dossier rows and
// community-added rows; a dossier whose fields are all "not publicly listed"
// does not count.
function hasContactChannel(e) {
  if (!e) return false;
  return !!(
    websiteUrl(e.Website) ||
    (!isMissing(e['Public contact email']) && firstEmail(e['Public contact email'])) ||
    (!isMissing(e['Public phone']) && firstPhone(e['Public phone']))
  );
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Registry names arrive in ALL CAPS with a legal suffix. For display only,
// title-case an all-caps name and split off the suffix, so the list reads
// "Digital One Box · Private Limited" instead of a wall of capitals. Search,
// matching and the add form keep using the raw name.
const LEGAL_SUFFIX_RE = /[\s,]+(?:\(OPC\)\s*)?(?:PRIVATE LIMITED|PVT\.?\s*LTD\.?|PRIVATE LTD\.?|PVT\.?\s*LIMITED|LIMITED|LLP|OPC)\.?\s*$/i;
const SMALL_WORDS = new Set(['and', 'of', 'the', 'for', 'in', 'on', 'at', 'to', 'by']);
const SHORT_CAPITALISED = new Set(['pvt', 'ltd', 'inc', 'co']);
// Tokens that stay upper-case when title-casing (plus anything with a digit or
// without a vowel, e.g. MS, HR, CRM, 3D, MSG91).
const ACRONYMS = new Set(['it', 'ai', 'ml', 'iot', 'hr', 'llp', 'opc', 'ids', 'ui', 'ux', 'ar', 'vr', 'ev', 'gis', 'erp', 'crm', 'api', 'ott', 'edu', 'llc', 'b2b', 'b2c', 'saas', 'usa', 'uk', 'ngo', 'seo', 'ceo', 'led', 'lms', 'pos', 'sme', 'msme', 'nit', 'iit', 'cad', 'cnc']);
function titleCase(s) {
  let first = true;
  return String(s).replace(/[A-Za-z0-9][A-Za-z0-9'.]*/g, (w) => {
    const lw = w.toLowerCase();
    const isFirst = first;
    first = false;
    if (!isFirst && SMALL_WORDS.has(lw)) return lw;
    if (SHORT_CAPITALISED.has(lw)) return w.charAt(0).toUpperCase() + lw.slice(1);
    if (ACRONYMS.has(lw) || /\d/.test(w) || !/[aeiouy]/.test(lw)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + lw.slice(1);
  });
}
function displayName(name) {
  const raw = String(name == null ? '' : name).trim();
  const allCaps = /[A-Z]/.test(raw) && raw === raw.toUpperCase();
  const m = raw.match(LEGAL_SUFFIX_RE);
  let main = m ? raw.slice(0, m.index).trim() : raw;
  let suffix = m ? m[0].replace(/^[\s,]+/, '').trim() : '';
  if (!main) { main = raw; suffix = ''; }
  if (allCaps) { main = titleCase(main); suffix = titleCase(suffix); }
  return { main, suffix };
}
function nameHtml(name, cls) {
  const { main, suffix } = displayName(name);
  return escapeHtml(main) + (suffix ? ` <span class="${cls}">${escapeHtml(suffix)}</span>` : '');
}

// Find the known district named in a free-text location ("Pithampur, Dhar",
// "Indore/Bhopal") — the same rule the server applies when a record is added.
function districtFromText(text) {
  return canonicalDistrict(text, DISTRICT_NAMES);
}

// A dossier's own location text. Most rows use `City`; the registry_gems batch
// uses `District` instead (e.g. "Indore/Bhopal", "Bhopal (registered; …)").
function dossierLocation(e) {
  return String((e && (e.City || e.District)) || '').trim();
}

// ============================================================
// Data loading + merge
// ============================================================

let API_AVAILABLE = false;

// An error whose message is safe and useful to show on the loading screen.
class LoadError extends Error {
  constructor(userMessage) {
    super(userMessage);
    this.userMessage = userMessage;
  }
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

// GET /api/startups. Resolves to the payload, or to null when there is no API
// at all (plain static hosting: network error, 404/405, or a non-JSON answer).
// A live server that refuses the request (429 rate limit, 403 host/origin
// guard, 5xx) is NOT static hosting — the static files are locked down there,
// so that surfaces as a LoadError with the real reason instead of a misleading
// "serve this folder over HTTP" message.
async function fetchApiStartups() {
  let response;
  try {
    response = await fetch('/api/startups');
  } catch (_) {
    return null;
  }
  const isJson = String(response.headers.get('content-type') || '').includes('application/json');
  if (response.status === 404 || response.status === 405 || !isJson) return null;
  if (!response.ok) {
    const messages = {
      429: 'The server is rate-limiting this address — wait a minute and reload.',
      403: 'The server refused this request (host or origin not allowed — see README).',
    };
    throw new LoadError(messages[response.status] || `The server returned an error (${response.status}). Check its console and reload.`);
  }
  return response.json();
}

async function loadData() {
  let coords = {};
  let registry = [];
  let enriched = [];
  let user = [];

  // API first: registry + dossiers + persisted user records + district centroids
  // in one payload. data/*.json is locked down on the Node server, so COORDS
  // must come from this response — never from a static fetch.
  const api = await fetchApiStartups();
  if (api) {
    registry = Array.isArray(api.registry) ? api.registry : [];
    enriched = Array.isArray(api.enriched) ? api.enriched : [];
    user = Array.isArray(api.user) ? api.user : [];
    coords = api.coords && typeof api.coords === 'object' ? api.coords : {};
    API_AVAILABLE = true;
    if (!Object.keys(coords).length) {
      console.warn('API returned no district centroids — pins will sit at the MP centre.');
    }
  } else {
    // Static fallback: any plain HTTP server that serves data/*.json (no Add / Verify).
    API_AVAILABLE = false;
    coords = await fetchJson('./data/district_coords.json');
    registry = await fetchJson('./data/tech_registry.json');
    try {
      enriched = await fetchJson('./data/enriched.json');
    } catch (_) {
      console.warn('enriched.json unavailable — continuing with registry data only.');
    }
    try {
      user = await fetchJson('./data/user_startups.json');
      if (!Array.isArray(user)) user = [];
    } catch (_) {
      user = []; // no user file in pure-static mode
    }
  }

  COORDS = coords;
  DISTRICT_NAMES = Object.keys(coords).sort((a, b) => b.length - a.length);

  STARTUPS = mergeData(registry, enriched, user);
  for (const rec of STARTUPS) assignCoords(rec);
}

// Build the normalized, merged record list from the three datasets.
function mergeData(registry, enriched, user) {
  const records = registry.map((row, i) => {
    const [name, dipp, sector, industry, district] = row;
    return {
      id: 'r' + i,
      name: name,
      dipp: dipp,
      sector: sector || '',
      industry: industry || '',
      district: district && district.trim() ? district.trim() : 'Unknown',
      enriched: null,
      hasContacts: false,
    };
  });

  const byDipp = new Map();
  const byName = new Map();
  for (const rec of records) {
    const d = normDipp(rec.dipp);
    if (d) byDipp.set(d, rec);
    const n = normName(rec.name);
    if (n && !byName.has(n)) byName.set(n, rec);
  }

  // Attach each dossier to a matching registry record, else keep as standalone.
  let standaloneIdx = 0;
  for (const e of enriched) {
    const company = e.Company || '';
    const dippMatch = normDipp((company.match(/DIPP\d+/i) || [])[0]);
    let target = null;

    if (dippMatch && byDipp.has(dippMatch)) {
      target = byDipp.get(dippMatch);
    } else {
      // "Legal Name / Brand (DIPPnnnnn)": try each alias, never the DPIIT suffix.
      for (const part of company.split(/[\/(]/)) {
        if (/^\s*DIPP\d+/i.test(part)) continue;
        const n = normName(part);
        if (n && byName.has(n)) { target = byName.get(n); break; }
      }
    }

    const dossierDistrict = districtFromText(dossierLocation(e));
    if (target) {
      target.enriched = e;
      target.hasContacts = hasContactChannel(e);
      // A registry row with a blank district takes the dossier's location.
      if (target.district === 'Unknown' && dossierDistrict) target.district = dossierDistrict;
    } else {
      records.push({
        id: 's' + standaloneIdx++,
        name: company.replace(/\s*\(DIPP\d+\)/i, '').trim(),
        dipp: dippMatch,
        sector: '',
        industry: '',
        // Same default as registry and community rows: never guess a district.
        district: dossierDistrict || districtFromText(company) || 'Unknown',
        enriched: e,
        hasContacts: hasContactChannel(e),
      });
    }
  }

  // Give standalone enriched a lightweight sector label so filters/chips work.
  for (const rec of records) {
    if (!rec.sector && rec.enriched) rec.sector = 'Notable startup';
  }

  // Append user-submitted records.
  let userIdx = 0;
  for (const u of user) {
    records.push(userToRecord(u, userIdx++));
  }

  for (const rec of records) indexRecord(rec);
  return records;
}

// What the search box matches against, built once per record.
function indexRecord(rec) {
  rec.searchText = [rec.name, rec.sector, rec.industry, rec.district].join(' ').toLowerCase();
  return rec;
}

// Convert a persisted user record into the internal record + dossier shape.
function userToRecord(u, idx) {
  // The server stores a canonical district; older records may hold free text,
  // so map it the same way and keep the raw value only as a last resort.
  const district = districtFromText(u.district) || districtFromText(u.city)
    || (u.district && String(u.district).trim()) || 'Unknown';
  const enriched = {
    Company: u.name || '',
    City: u.city || district,
    'What they build': u.description || '',
    Website: u.website || '',
    'Public contact email': u.email || '',
    'Public phone': u.phone || '',
    'Founder(s)': u.founders || '',
    'LinkedIn URL': u.linkedin || '',
    'Careers URL': u.careers || '',
    Source: u.sources || '',
    _user: true,
  };
  return {
    id: u.id || ('u' + idx),
    name: u.name || '',
    dipp: u.dipp || '',
    sector: u.sector || 'Community-added',
    industry: u.industry || '',
    district: district,
    enriched: enriched,
    hasContacts: hasContactChannel(enriched),
    isUser: true,
  };
}

// Assign map coordinates (district centroid + deterministic jitter).
function assignCoords(rec) {
  const base = COORDS[rec.district] || MP_CENTER;
  const [jx, jy] = hashJitter(rec.id + rec.name);
  rec.lat = base[0] + jx;
  rec.lng = base[1] + jy;
}

// ============================================================
// Map
// ============================================================

function initMap() {
  map = L.map('map', { preferCanvas: true, zoomControl: true }).setView(MP_CENTER, MP_ZOOM);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  // District counts drive marker radius.
  const counts = {};
  for (const s of STARTUPS) counts[s.district] = (counts[s.district] || 0) + 1;

  clusterGroup = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 50,
    iconCreateFunction: (cluster) => {
      const n = cluster.getChildCount();
      const size = n < 10 ? 34 : n < 50 ? 42 : 52;
      return L.divIcon({
        html: `<div><span>${n}</span></div>`,
        className: 'marker-cluster marker-cluster-mp',
        iconSize: L.point(size, size),
      });
    },
  });

  for (const s of STARTUPS) {
    const count = counts[s.district] || 1;
    clusterGroup.addLayer(makeMarker(s, count));
  }

  map.addLayer(clusterGroup);

  // On popupopen, wire the popup's "Full details" button to openDetail.
  map.on('popupopen', (ev) => {
    const node = ev.popup.getElement();
    const more = node && node.querySelector('.popup-more');
    if (more) more.addEventListener('click', () => openDetail(more.getAttribute('data-id')));
  });
}

// Count-based marker radius. Pins in a busier district read larger.
function radiusForCount(count) {
  return 5 + Math.min(11, Math.log2((count || 1) + 1) * 2.2);
}

// Pin colours come from the CSS tokens, so the legend, the card edge and the
// map can never drift apart. Read once, on first use.
let THEME = null;
function theme() {
  if (!THEME) {
    const css = getComputedStyle(document.documentElement);
    const read = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
    THEME = { green: read('--green', '#4ade80'), accent: read('--accent', '#ff8f3f'), blue: read('--blue', '#60a5fa') };
  }
  return THEME;
}

function makeMarker(s, count) {
  const radius = radiusForCount(count);
  const t = theme();
  const color = s.isUser ? t.blue : s.hasContacts ? t.green : t.accent;
  const marker = L.circleMarker([s.lat, s.lng], {
    radius,
    color,
    weight: 1.5,
    fillColor: color,
    fillOpacity: 0.55,
  });
  marker.bindPopup(popupHtml(s), { maxWidth: 280 });
  marker.on('click', () => setActive(s.id, false));
  markerById.set(s.id, marker);
  return marker;
}

function statusClass(s) {
  return s.isUser ? 'is-user' : s.hasContacts ? 'is-contact' : 'is-registry';
}

function popupHtml(s) {
  const e = s.enriched;
  const web = e ? websiteUrl(e.Website) : null;
  const email = e && !isMissing(e['Public contact email']) ? firstEmail(e['Public contact email']) : null;
  const phone = e && !isMissing(e['Public phone']) ? firstPhone(e['Public phone']) : null;

  let links = '';
  if (web) links += `<a href="${escapeHtml(web)}" target="_blank" rel="noopener noreferrer">🌐 ${escapeHtml(web.replace(/^https?:\/\//i, ''))}</a>`;
  if (email) links += `<a href="mailto:${escapeHtml(email)}">✉️ ${escapeHtml(email)}</a>`;
  if (phone) links += `<a href="${escapeHtml(telHref(phone))}">📞 ${escapeHtml(phone)}</a>`;

  return `
    <div class="popup-title">${nameHtml(s.name, 'name-suffix')}</div>
    <div class="popup-meta">${escapeHtml(s.sector || '—')}${s.industry ? ' · ' + escapeHtml(s.industry) : ''}</div>
    <div class="popup-meta">📍 ${escapeHtml(s.district)}</div>
    ${links ? `<div class="popup-links">${links}</div>` : ''}
    <button type="button" class="popup-more" data-id="${escapeHtml(s.id)}">Full details →</button>
  `;
}

// ============================================================
// List + filtering
// ============================================================

function currentFilter() {
  return {
    q: el.search.value.trim().toLowerCase(),
    district: el.district.value,
    sector: el.sector.value,
    contactsOnly: el.contacts.checked,
  };
}

function filtersActive(f) {
  return !!(f.q || f.district || f.sector || f.contactsOnly);
}

// ------------------------------------------------------------
// Shareable URL state: filters, sort and the open startup live in the hash
// (#q=…&district=…&sort=name&id=r12), written with replaceState so the
// browser history is not spammed and links can be copied straight from the bar.
// ------------------------------------------------------------
function readUrlState() {
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return {
    q: p.get('q') || '',
    district: p.get('district') || '',
    sector: p.get('sector') || '',
    contactsOnly: p.get('contacts') === '1',
    sort: p.get('sort') || '',
    id: p.get('id') || '',
  };
}

function applyUrlState(state) {
  el.search.value = state.q;
  if ([...el.district.options].some((o) => o.value === state.district)) el.district.value = state.district;
  if ([...el.sector.options].some((o) => o.value === state.sector)) el.sector.value = state.sector;
  el.contacts.checked = state.contactsOnly;
  if ([...el.sort.options].some((o) => o.value === state.sort)) el.sort.value = state.sort;
}

function writeUrlState() {
  const f = currentFilter();
  const p = new URLSearchParams();
  if (f.q) p.set('q', el.search.value.trim());
  if (f.district) p.set('district', f.district);
  if (f.sector) p.set('sector', f.sector);
  if (f.contactsOnly) p.set('contacts', '1');
  if (el.sort.value !== 'district') p.set('sort', el.sort.value);
  if (detailId) p.set('id', detailId);
  const hash = p.toString();
  const next = hash ? '#' + hash : window.location.pathname + window.location.search;
  if (window.location.hash !== (hash ? '#' + hash : '')) history.replaceState(null, '', next);
}

function resetFilters() {
  el.search.value = '';
  el.district.value = '';
  el.sector.value = '';
  el.contacts.checked = false;
  render();
}

function byName(a, b) {
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
}
function sortRecords(list, mode) {
  const sorted = [...list];
  if (mode === 'name') return sorted.sort(byName);
  if (mode === 'contacts') {
    return sorted.sort((a, b) => (b.hasContacts - a.hasContacts) || (b.isUser - a.isUser) || byName(a, b));
  }
  // 'district': grouped by district, A–Z inside each group ('Unknown' sorts last).
  const unknown = (s) => (s.district === 'Unknown' ? 1 : 0);
  return sorted.sort((a, b) => (unknown(a) - unknown(b)) || a.district.localeCompare(b.district, 'en') || byName(a, b));
}

// Card-shaped placeholders so the layout is stable while the data loads.
function renderSkeleton(count = 8) {
  el.list.innerHTML = Array.from({ length: count }, () =>
    '<li class="card skeleton" aria-hidden="true"><div class="sk sk-title"></div><div class="sk-row"><div class="sk sk-chip"></div><div class="sk sk-chip"></div></div></li>'
  ).join('');
}

function showLoadError(message) {
  el.list.innerHTML = '';
  el.listCount.textContent = '';
  el.loading.classList.remove('hidden');
  el.loading.classList.add('error');
  el.loading.innerHTML = `<strong>Couldn’t load the directory</strong><span>${escapeHtml(message)}</span>` +
    '<button type="button" class="btn-secondary" id="retry-load">Try again</button>';
  $('retry-load').addEventListener('click', () => window.location.reload());
}

function matches(s, f) {
  if (f.district && s.district !== f.district) return false;
  if (f.sector && s.sector !== f.sector) return false;
  if (f.contactsOnly && !s.hasContacts) return false;
  if (f.q && !s.searchText.includes(f.q)) return false;
  return true;
}

function render() {
  const f = currentFilter();
  const shown = sortRecords(STARTUPS.filter((s) => matches(s, f)), el.sort.value);
  el.reset.disabled = !filtersActive(f);

  // List
  el.list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const s of shown) {
    const li = document.createElement('li');
    li.className = 'card ' + statusClass(s);
    li.dataset.id = s.id;
    // Keyboard-selectable: Enter opens the detail drawer, Space locates on the map.
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.setAttribute('aria-label', `${s.name} — Enter for details, Space to locate on map`);
    li.innerHTML = `
      <div class="card-title">
        <span class="name">${nameHtml(s.name, 'name-suffix')}</span>
        ${s.hasContacts ? '<span class="dot-contact" title="Public contact details available"></span>' : ''}
      </div>
      <div class="card-meta">
        <span class="chip district">${escapeHtml(s.district)}</span>
        ${s.sector ? `<span class="chip">${escapeHtml(s.sector)}</span>` : ''}
        ${s.industry ? `<span class="chip">${escapeHtml(s.industry)}</span>` : ''}
      </div>`;
    li.addEventListener('click', () => flyTo(s.id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        openDetail(s.id);
      } else if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        flyTo(s.id);
      }
    });
    frag.appendChild(li);
  }
  el.list.appendChild(frag);
  el.empty.hidden = shown.length !== 0;
  writeUrlState();
  el.listCount.textContent = shown.length === STARTUPS.length
    ? `${STARTUPS.length} startups`
    : `${shown.length} of ${STARTUPS.length} startups`;

  // Marker visibility: rebuild cluster layer with the filtered subset.
  clusterGroup.clearLayers();
  const layers = [];
  for (const s of shown) {
    const m = markerById.get(s.id);
    if (m) layers.push(m);
  }
  clusterGroup.addLayers(layers);

  // Stats
  el.statTotal.textContent = shown.length;
  el.statDistricts.textContent = new Set(shown.map((s) => s.district)).size;
  el.statSectors.textContent = new Set(shown.map((s) => s.sector).filter(Boolean)).size;
  el.statContacts.textContent = shown.filter((s) => s.hasContacts).length;
}

// ============================================================
// Interaction: list <-> map linking
// ============================================================

function setActive(id, scrollList = true) {
  document.querySelectorAll('.card.active').forEach((c) => c.classList.remove('active'));
  const card = el.list.querySelector(`.card[data-id="${id}"]`);
  if (card) {
    card.classList.add('active');
    if (scrollList) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function flyTo(id) {
  const s = STARTUPS.find((x) => x.id === id);
  const marker = markerById.get(id);
  if (!s || !marker) return;
  setActive(id, false);

  // On mobile, jump to the map tab so the fly-to is visible.
  if (window.innerWidth <= 820) {
    document.body.classList.remove('show-list');
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.tab === 'map');
    });
    map.invalidateSize();
  }

  map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 11), { duration: 0.6, animate: !REDUCED_MOTION });
  // Open popup once the (possibly clustered) marker is visible.
  clusterGroup.zoomToShowLayer(marker, () => marker.openPopup());
}

// ============================================================
// Detail drawer
// ============================================================

function detailRow(label, value, opts = {}) {
  if (isMissing(value)) {
    return `<dt>${escapeHtml(label)}</dt><dd class="muted">not publicly listed</dd>`;
  }
  let html;
  if (opts.type === 'url') {
    const url = websiteUrl(value);
    html = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a>`
      : escapeHtml(value);
  } else if (opts.type === 'email') {
    const em = firstEmail(value);
    html = em ? `<a href="mailto:${escapeHtml(em)}">${escapeHtml(value)}</a>` : escapeHtml(value);
  } else if (opts.type === 'phone') {
    const phone = firstPhone(value);
    html = phone ? `<a href="${escapeHtml(telHref(phone))}">${escapeHtml(value)}</a>` : escapeHtml(value);
  } else {
    html = escapeHtml(value);
  }
  return `<dt>${escapeHtml(label)}</dt><dd>${html}</dd>`;
}

let detailReturnFocus = null; // element to refocus when the drawer closes
let detailId = null;          // record currently shown in the drawer

function openDetail(id) {
  const s = STARTUPS.find((x) => x.id === id);
  if (!s) return;
  setActive(id, true);
  detailId = id;

  let body = `<h2 id="detail-title">${nameHtml(s.name, 'd-suffix')}</h2>`;
  const e = s.enriched;
  const web = e ? websiteUrl(e.Website) : null;
  body += '<div class="d-actions">' +
    '<button type="button" class="btn-secondary" data-action="locate">Show on map</button>' +
    (web ? `<a class="btn-primary" href="${escapeHtml(web)}" target="_blank" rel="noopener noreferrer">Website ↗</a>` : '') +
    '</div>';

  if (e) {
    body += `<div class="d-sub">${escapeHtml(dossierLocation(e) || s.district)}${s.dipp ? ' · ' + escapeHtml(s.dipp) : ''}</div>`;
    body += `<span class="badge enriched">● Contact dossier</span>`;
    if (!isMissing(e['What they build'])) {
      body += `<p class="d-desc">${escapeHtml(e['What they build'])}</p>`;
    }
    body += `<dl class="d-grid">
      ${detailRow('District', s.district)}
      ${s.sector && s.sector !== 'Notable startup' ? detailRow('Sector', s.sector) : ''}
      ${s.industry ? detailRow('Industry', s.industry) : ''}
      ${detailRow('Founders', e['Founder(s)'])}
      ${detailRow('Website', e.Website, { type: 'url' })}
      ${detailRow('Email', e['Public contact email'], { type: 'email' })}
      ${detailRow('Phone', e['Public phone'], { type: 'phone' })}
      ${detailRow('LinkedIn', e['LinkedIn URL'], { type: 'url' })}
      ${detailRow('Careers', e['Careers URL'], { type: 'url' })}
    </dl>`;
    if (!isMissing(e.Source)) {
      body += `<div class="d-source"><strong>Sources:</strong> ${escapeHtml(e.Source)}</div>`;
    }
  } else {
    body += `<div class="d-sub">${escapeHtml(s.district)}${s.dipp ? ' · ' + escapeHtml(s.dipp) : ''}</div>`;
    body += `<span class="badge registry">DPIIT registry</span>`;
    body += `<dl class="d-grid">
      ${detailRow('DPIIT number', s.dipp)}
      ${detailRow('Sector', s.sector)}
      ${detailRow('Industry', s.industry)}
      ${detailRow('District', s.district)}
    </dl>`;
    body += `<div class="d-note">Contact details not yet researched for this company.</div>`;
  }

  // Actions row sits under the title; the sub-heading follows it.
  el.detailBody.innerHTML = body;
  if (el.detail.hidden) detailReturnFocus = document.activeElement;
  el.detail.hidden = false;
  el.detailBackdrop.hidden = false;
  el.detailClose.focus(); // dialog: move focus in, restore on close
  writeUrlState();
}

function closeDetail() {
  if (el.detail.hidden) return;
  el.detail.hidden = true;
  el.detailBackdrop.hidden = true;
  detailId = null;
  writeUrlState();
  if (detailReturnFocus && typeof detailReturnFocus.focus === 'function' && document.contains(detailReturnFocus)) {
    detailReturnFocus.focus();
  }
  detailReturnFocus = null;
}

// ============================================================
// Filter option population
// ============================================================

function populateFilters() {
  const districts = [...new Set(STARTUPS.map((s) => s.district))].sort();
  const sectors = [...new Set(STARTUPS.map((s) => s.sector).filter(Boolean))].sort();

  // Rebuild the filter selects (keep the leading "All …" option).
  fillSelect(el.district, districts);
  fillSelect(el.sector, sectors);

  // Fill the add-form datalists. The district suggestions are exactly the
  // canonical list the server accepts (never 'Unknown' or legacy free text).
  if (el.districtOptions) fillDatalist(el.districtOptions, Object.keys(COORDS).sort());
  if (el.sectorOptions) fillDatalist(el.sectorOptions, sectors);
}

function fillSelect(select, values) {
  const current = select.value;
  // Drop everything after the first ("All …") option, then repopulate.
  while (select.options.length > 1) select.remove(1);
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    select.appendChild(o);
  }
  if (values.includes(current)) select.value = current;
}

function fillDatalist(list, values) {
  list.innerHTML = '';
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    list.appendChild(o);
  }
}

// ============================================================
// Events
// ============================================================

function debounce(fn, ms) {
  let timer = null;
  return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
}

function wireEvents() {
  el.search.addEventListener('input', debounce(render, 80));
  el.district.addEventListener('change', render);
  el.sector.addEventListener('change', render);
  el.contacts.addEventListener('change', render);
  el.sort.addEventListener('change', render);
  el.reset.addEventListener('click', resetFilters);
  el.emptyReset.addEventListener('click', () => { resetFilters(); el.search.focus(); });

  // "/" focuses the search from anywhere that is not already a text field.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!el.detail.hidden || !el.addModal.hidden) return;
    e.preventDefault();
    el.search.focus();
    el.search.select();
  });

  el.detailClose.addEventListener('click', closeDetail);
  el.detailBackdrop.addEventListener('click', closeDetail);
  // "Show on map" inside the drawer: close it and fly to the pin.
  el.detailBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="locate"]');
    if (!btn || !detailId) return;
    const id = detailId;
    closeDetail();
    flyTo(id);
  });

  // One Escape handler for both overlays: close only the topmost (the add
  // modal, z-index 1500, sits above the detail drawer, z-index 1300).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = el.addModal;
    if (modal && !modal.hidden) closeAddModal();
    else closeDetail();
  });
  containTab(el.detail);

  // Double-click a list card opens the detail drawer; a single click (wired in
  // render()) flies to its pin.
  el.list.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) openDetail(card.dataset.id);
  });

  // Mobile tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.body.classList.toggle('show-list', tab.dataset.tab === 'list');
      if (tab.dataset.tab === 'map') setTimeout(() => map.invalidateSize(), 50);
    });
  });
}

// aria-modal="true" promises that Tab never leaves the dialog; keep that
// promise for both overlays by wrapping focus at either end. The listener is on
// the document (like Escape) because a click on plain text inside an overlay
// parks focus on <body>, where a container-level listener would never see the
// next Tab. Only the topmost open overlay traps (the add modal sits above the
// detail drawer).
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function containTab(container) {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || container.hidden) return;
    const modal = el.addModal;
    if (container !== modal && modal && !modal.hidden) return;
    const focusable = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter((n) => !n.hidden && n.offsetParent !== null);
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const inside = active && active !== container && container.contains(active);
    if (!inside) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  });
}

// ============================================================
// Add-startup: modal, verify, submit, toast
// ============================================================

const FORM_FIELDS = [
  'name', 'dipp', 'district', 'city', 'sector', 'industry', 'description',
  'website', 'email', 'phone', 'founders', 'linkedin', 'careers', 'sources',
];

let verifiedClean = false; // becomes true after a passing verify; gates Add

function formEl(name) { return $('f-' + name); }

function collectForm() {
  const data = {};
  for (const f of FORM_FIELDS) {
    const node = formEl(f);
    data[f] = node ? node.value.trim() : '';
  }
  return data;
}

// Transient admin token: read straight off the field, sent only as a header on
// POST /api/startups. It is never part of collectForm() / the persisted record.
function adminTokenHeader() {
  const val = el.adminToken && el.adminToken.value ? el.adminToken.value.trim() : '';
  return val ? { 'X-Admin-Token': val } : {};
}

function clearFieldErrors() {
  document.querySelectorAll('.field-err').forEach((n) => { n.textContent = ''; });
  document.querySelectorAll('.field.invalid').forEach((n) => n.classList.remove('invalid'));
}

function showFieldErrors(errors) {
  clearFieldErrors();
  for (const [field, msg] of Object.entries(errors || {})) {
    const errNode = document.querySelector(`.field-err[data-for="${field}"]`);
    if (errNode) {
      errNode.textContent = msg;
      const wrap = errNode.closest('.field');
      if (wrap) wrap.classList.add('invalid');
    }
  }
}

function setVerified(clean) {
  verifiedClean = clean;
  el.submitBtn.disabled = !clean;
  if (el.formHint) el.formHint.textContent = clean ? 'Verified — no duplicates. You can add it.' : 'Verify first to enable Add.';
}

function hideVerifyResult() {
  const vr = el.verifyResult;
  vr.hidden = true;
  vr.innerHTML = '';
  vr.className = 'verify-result';
}

// Editing any field after a clean verification makes that result stale: drop
// both the Add gate and the green "clear to add" panel together.
function invalidateVerification() {
  if (!verifiedClean) return;
  setVerified(false);
  hideVerifyResult();
}

function openAddModal() {
  el.modalBackdrop.hidden = false;
  el.addModal.hidden = false;
  setVerified(false);
  hideVerifyResult();
  const first = formEl('name');
  if (first) first.focus();
}

function closeAddModal() {
  if (el.addModal.hidden) return;
  el.addModal.hidden = true;
  el.modalBackdrop.hidden = true;
  el.addBtn.focus(); // dialog closed: return focus to its opener
}

function resetAddForm() {
  el.addForm.reset();
  clearFieldErrors();
  hideVerifyResult();
  setVerified(false);
}

// Human-readable reason for a non-2xx API answer. Every server failure is
// `{ error: <code> }`; spell out the ones the user can act on.
function apiFailureMessage(status, payload, what) {
  const code = payload && payload.error;
  if (status === 429 || code === 'rate_limited') return 'Too many requests — wait a minute and try again.';
  if (status === 413) return 'The form is too large to send (64 KiB limit). Shorten the long fields.';
  if (status === 403) {
    return code === 'write_forbidden'
      ? 'Adding is not permitted from this location (admin token required).'
      : 'The server refused the request (host or origin not allowed).';
  }
  return `Could not ${what} (server error ${status}). Please try again.`;
}

function showVerifyFailure(message) {
  const vr = el.verifyResult;
  vr.hidden = false;
  vr.className = 'verify-result bad';
  vr.textContent = message;
  setVerified(false);
  focusVerifyResult();
}

// Move focus onto the (tabindex="-1") result panel so the outcome is read out
// and keyboard focus stays inside the aria-modal dialog — the Verify/Add button
// that had focus disables itself during the request, which would otherwise drop
// focus to <body>.
function focusVerifyResult() {
  const vr = el.verifyResult;
  if (!vr.hidden && !el.addModal.hidden && typeof vr.focus === 'function') vr.focus();
}

// Keep keyboard focus inside the open add dialog after a request completes.
function keepFocusInAddModal(fallback) {
  const modal = el.addModal;
  if (modal.hidden || modal.contains(document.activeElement)) return;
  if (fallback && !fallback.disabled) fallback.focus();
  else el.verifyBtn.focus();
}

function renderVerifyResult(payload) {
  const vr = el.verifyResult;
  vr.hidden = false;

  if (payload.errors && Object.keys(payload.errors).length) {
    showFieldErrors(payload.errors);
    vr.className = 'verify-result bad';
    vr.textContent = 'Please fix the highlighted fields.';
    setVerified(false);
    focusVerifyResult();
    return;
  }
  clearFieldErrors();

  if (payload.duplicate) {
    const reason = (m) => ({ name: 'same name', website: 'same website', dipp: 'same DPIIT number' }[m.on] || m.on);
    const items = payload.matches.map((m) =>
      `<li><strong>${escapeHtml(reason(m))}</strong> as <em>${escapeHtml(m.name || m.value)}</em> <span class="src">(${escapeHtml(m.source)})</span></li>`
    ).join('');
    vr.className = 'verify-result bad';
    vr.innerHTML = `<div class="vr-title">Already in the directory</div><ul class="vr-list">${items}</ul>`;
    setVerified(false);
    focusVerifyResult();
  } else if (payload.duplicate === false) {
    vr.className = 'verify-result good';
    vr.innerHTML = '<div class="vr-title">✓ No duplicates found — clear to add.</div>';
    setVerified(true);
    focusVerifyResult();
  } else {
    // Not a verify result at all — never treat an unknown body as "clean".
    showVerifyFailure('Unexpected response from the verify service. Please try again.');
  }
}

async function verifyStartup() {
  const btn = el.verifyBtn;
  btn.disabled = true;
  try {
    const res = await fetch('/api/startups/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectForm()),
    });
    const payload = await res.json().catch(() => ({}));
    // Only a 200 (verify result) or a 400 with field errors is a verify answer;
    // 429/403/413/415/500 are `{ error }` envelopes and must never read as "clean".
    if (res.ok || (res.status === 400 && payload.errors)) {
      renderVerifyResult(payload);
    } else {
      showVerifyFailure(apiFailureMessage(res.status, payload, 'verify the record'));
    }
  } catch (err) {
    console.error('verify failed:', err);
    showVerifyFailure(API_AVAILABLE
      ? 'Could not reach the verify service. Check the server and try again.'
      : 'Verification needs the Node server (node server.js). It is not available in static mode.');
  } finally {
    btn.disabled = false;
    keepFocusInAddModal(btn);
  }
}

async function submitStartup(ev) {
  ev.preventDefault();
  if (!verifiedClean) {
    toast('Verify the record before adding.', 'bad');
    return;
  }
  const btn = el.submitBtn;
  btn.disabled = true;
  try {
    const res = await fetch('/api/startups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminTokenHeader() },
      body: JSON.stringify(collectForm()),
    });
    const payload = await res.json().catch(() => ({}));

    if (res.status === 201 && payload.record) {
      insertRecord(payload.record);
      toast(`Added “${payload.record.name}” to the directory.`, 'good');
      closeAddModal();
      resetAddForm();
    } else if (res.status === 409) {
      renderVerifyResult({ duplicate: true, matches: payload.matches || [] });
      toast('That startup is already listed.', 'bad');
    } else if (res.status === 400 && payload.errors && Object.keys(payload.errors).length) {
      renderVerifyResult({ errors: payload.errors });
      toast('Some fields need fixing.', 'bad');
    } else {
      toast(apiFailureMessage(res.status, payload, 'add the startup'), 'bad');
    }
  } catch (err) {
    console.error('add failed:', err);
    toast(API_AVAILABLE ? 'Network error while adding.' : 'Adding needs the Node server (node server.js).', 'bad');
  } finally {
    btn.disabled = !verifiedClean;
    keepFocusInAddModal(btn); // no-op once the modal has closed after a successful add
  }
}

// Insert a newly created record into the live map/list without a full reload.
function insertRecord(record) {
  const rec = indexRecord(userToRecord(record, STARTUPS.length));
  assignCoords(rec);
  STARTUPS.push(rec);

  const counts = {};
  for (const s of STARTUPS) counts[s.district] = (counts[s.district] || 0) + 1;
  const marker = makeMarker(rec, counts[rec.district]);
  if (clusterGroup) clusterGroup.addLayer(marker);

  // The new record bumps its district's count, which changes the count-based
  // radius for EVERY pin in that district — refresh them all, not just the new
  // one. Colours/filters/clustering are untouched.
  refreshDistrictRadii(rec.district, counts);

  populateFilters();
  render();
}

// Resize every existing marker in a district to match its updated count.
function refreshDistrictRadii(district, counts) {
  const radius = radiusForCount(counts[district] || 1);
  for (const s of STARTUPS) {
    if (s.district !== district) continue;
    const m = markerById.get(s.id);
    if (m && typeof m.setRadius === 'function') m.setRadius(radius);
  }
}

function toast(message, kind) {
  if (!el.toastRegion) return;
  const node = document.createElement('div');
  node.className = 'toast' + (kind ? ' ' + kind : ''); // kind: 'good' | 'bad'
  node.textContent = message;
  el.toastRegion.appendChild(node);
  setTimeout(() => { node.classList.add('show'); }, 10);
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 300);
  }, 4200);
}

function wireAddStartup() {
  el.addBtn.addEventListener('click', openAddModal);
  el.addClose.addEventListener('click', closeAddModal);
  el.modalBackdrop.addEventListener('click', closeAddModal);
  el.verifyBtn.addEventListener('click', verifyStartup);
  el.addForm.addEventListener('submit', submitStartup);
  containTab(el.addModal);
  // Escape is handled once, for both overlays, in wireEvents().
  // Editing any field invalidates a prior verification.
  for (const f of FORM_FIELDS) {
    const node = formEl(f);
    if (node) node.addEventListener('input', invalidateVerification);
  }
}

// ============================================================
// Boot
// ============================================================

(async function main() {
  renderSkeleton();
  try {
    await loadData();
    populateFilters();
    initMap();
    wireEvents();
    wireAddStartup();
    const urlState = readUrlState();
    applyUrlState(urlState);
    render();
    // Deep link: #id=<record id> opens that startup and flies to its pin.
    if (urlState.id && STARTUPS.some((s) => s.id === urlState.id)) {
      flyTo(urlState.id);
      openDetail(urlState.id);
    }
    // Static hosting (no Node server): adding is not possible, so do not offer it.
    if (!API_AVAILABLE) el.addBtn.hidden = true;
  } catch (err) {
    console.error('Failed to initialize MP Startup Map:', err);
    showLoadError(err.userMessage || 'Serve this folder over HTTP (see README) and reload.');
    return;
  }
  el.loading.classList.add('hidden');
})();
