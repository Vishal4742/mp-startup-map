'use strict';

/* ============================================================
   MP Startup Map — vanilla JS
   Data: data/tech_registry.json (656 rows), data/enriched.json (80),
         data/district_coords.json (district HQ centroids).
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
  loading: $('loading'),
  detail: $('detail'),
  detailBody: $('detail-body'),
  detailBackdrop: $('detail-backdrop'),
  detailClose: $('detail-close'),
  statTotal: $('stat-total'),
  statDistricts: $('stat-districts'),
  statSectors: $('stat-sectors'),
  statContacts: $('stat-contacts'),
};

let map, clusterGroup;

// ============================================================
// Helpers
// ============================================================

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .split('(')[0].split('/')[0].split('→')[0]
    .replace(/private limited|pvt\.? ?ltd\.?|llp|limited|technologies|technology/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

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

const isMissing = (v) => {
  if (!v) return true;
  const t = String(v).trim().toLowerCase();
  return t === '' || t.startsWith('not publicly listed') || t.startsWith('not listed') || t === 'n/a';
};

const firstUrl = (s) => {
  const m = String(s || '').match(/https?:\/\/[^\s,()]+/);
  return m ? m[0] : null;
};
const firstEmail = (s) => {
  const m = String(s || '').match(/[^\s,;()<]+@[^\s,;()>]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Find the first known district name that appears in a free-text city string.
function districtFromText(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  for (const d of DISTRICT_NAMES) {
    if (t.includes(d.toLowerCase())) return d;
  }
  return null;
}

// ============================================================
// Data loading + merge
// ============================================================

let API_AVAILABLE = false;

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

async function loadData() {
  let coords = null;
  let registry = [];
  let enriched = [];
  let user = [];

  // Prefer the API (registry + enriched + persisted user records + district
  // centroids, all combined). data/*.json is locked down on the Node server, so
  // COORDS must come from the API response here — not a separate static fetch.
  try {
    const api = await fetchJson('/api/startups');
    registry = Array.isArray(api.registry) ? api.registry : [];
    enriched = Array.isArray(api.enriched) ? api.enriched : [];
    user = Array.isArray(api.user) ? api.user : [];
    coords = api.coords && typeof api.coords === 'object' ? api.coords : null;
    API_AVAILABLE = true;
  } catch (e) {
    // Static fallback: works from any plain HTTP server without the backend,
    // which DOES serve data/*.json — so the centroids come from the static file.
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

  // The API may omit coords on older builds; fall back to the static file so the
  // map still places pins.
  if (!coords || !Object.keys(coords).length) {
    coords = await fetchJson('./data/district_coords.json');
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
    if (rec.dipp) byDipp.set(String(rec.dipp).toUpperCase(), rec);
    const n = normName(rec.name);
    if (n && !byName.has(n)) byName.set(n, rec);
  }

  // Attach each dossier to a matching registry record, else keep as standalone.
  let standaloneIdx = 0;
  for (const e of enriched) {
    const company = e.Company || '';
    const dippMatch = (company.match(/DIPP\d+/i) || [])[0];
    let target = null;

    if (dippMatch && byDipp.has(dippMatch.toUpperCase())) {
      target = byDipp.get(dippMatch.toUpperCase());
    } else {
      for (const part of company.split(/[\/(]/)) {
        const n = normName(part);
        if (n && byName.has(n)) { target = byName.get(n); break; }
      }
    }

    if (target) {
      target.enriched = e;
      target.hasContacts = true;
    } else {
      const cityText = e.City || company;
      const district = districtFromText(cityText) || 'Indore';
      records.push({
        id: 's' + standaloneIdx++,
        name: company.replace(/\s*\(DIPP\d+\)/i, '').trim(),
        dipp: dippMatch || '',
        sector: '',
        industry: '',
        district: district,
        enriched: e,
        hasContacts: true,
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

  return records;
}

// Convert a persisted user record into the internal record + dossier shape.
function userToRecord(u, idx) {
  const district = (u.district && String(u.district).trim())
    || districtFromText(u.city) || 'Unknown';
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
    hasContacts: !!(u.website || u.email || u.phone),
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

  // Delegated handler for the "Full details" link inside popups.
  map.on('popupopen', (ev) => {
    const node = ev.popup.getElement();
    const more = node && node.querySelector('.popup-more');
    if (more) more.addEventListener('click', () => openDetail(more.getAttribute('data-id')));
  });
}

function makeMarker(s, count) {
  const radius = 5 + Math.min(11, Math.log2((count || 1) + 1) * 2.2);
  const color = s.isUser ? '#60a5fa' : s.hasContacts ? '#4ade80' : '#ff8f3f';
  const marker = L.circleMarker([s.lat, s.lng], {
    radius,
    color,
    weight: 1.5,
    fillColor: color,
    fillOpacity: 0.55,
  });
  marker.bindPopup(popupHtml(s), { maxWidth: 280 });
  marker.on('click', () => setActive(s.id, false));
  marker._recId = s.id;
  markerById.set(s.id, marker);
  return marker;
}

function popupHtml(s) {
  const web = s.enriched ? firstUrl(s.enriched.Website) : null;
  const email = s.enriched ? firstEmail(s.enriched['Public contact email']) : null;
  const phoneRaw = s.enriched && !isMissing(s.enriched['Public phone']) ? s.enriched['Public phone'] : null;

  let links = '';
  if (web) links += `<a href="${escapeHtml(web)}" target="_blank" rel="noopener noreferrer">🌐 ${escapeHtml(web.replace(/^https?:\/\//, ''))}</a>`;
  if (email) links += `<a href="mailto:${escapeHtml(email)}">✉️ ${escapeHtml(email)}</a>`;
  if (phoneRaw) links += `<a href="tel:${escapeHtml(String(phoneRaw).replace(/[^\d+]/g, ''))}">📞 ${escapeHtml(phoneRaw)}</a>`;

  return `
    <div class="popup-title">${escapeHtml(s.name)}</div>
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

function matches(s, f) {
  if (f.district && s.district !== f.district) return false;
  if (f.sector && s.sector !== f.sector) return false;
  if (f.contactsOnly && !s.hasContacts) return false;
  if (f.q) {
    const hay = (s.name + ' ' + s.sector + ' ' + s.industry + ' ' + s.district).toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

function render() {
  const f = currentFilter();
  const shown = STARTUPS.filter((s) => matches(s, f));

  // List
  el.list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const s of shown) {
    const li = document.createElement('li');
    li.className = 'card';
    li.dataset.id = s.id;
    // Keyboard-selectable: Enter opens the detail drawer, Space locates on the map.
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.setAttribute('aria-label', `${s.name} — Enter for details, Space to locate on map`);
    li.innerHTML = `
      <div class="card-title">
        <span class="name">${escapeHtml(s.name)}</span>
        ${s.hasContacts ? '<span class="dot-contact" title="Contact dossier available"></span>' : ''}
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

  map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 11), { duration: 0.6 });
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
    const url = firstUrl(value);
    html = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a>`
      : escapeHtml(value);
  } else if (opts.type === 'email') {
    const em = firstEmail(value);
    html = em ? `<a href="mailto:${escapeHtml(em)}">${escapeHtml(value)}</a>` : escapeHtml(value);
  } else if (opts.type === 'phone') {
    html = `<a href="tel:${escapeHtml(String(value).replace(/[^\d+]/g, ''))}">${escapeHtml(value)}</a>`;
  } else {
    html = escapeHtml(value);
  }
  return `<dt>${escapeHtml(label)}</dt><dd>${html}</dd>`;
}

function openDetail(id) {
  const s = STARTUPS.find((x) => x.id === id);
  if (!s) return;
  setActive(id, true);

  let body = `<h2>${escapeHtml(s.name)}</h2>`;
  const e = s.enriched;

  if (e) {
    body += `<div class="d-sub">${escapeHtml(e.City || s.district)}${s.dipp ? ' · ' + escapeHtml(s.dipp) : ''}</div>`;
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
      ${detailRow('DIPP no.', s.dipp)}
      ${detailRow('Sector', s.sector)}
      ${detailRow('Industry', s.industry)}
      ${detailRow('District', s.district)}
    </dl>`;
    body += `<div class="d-note">Contact details not yet researched for this company.</div>`;
  }

  el.detailBody.innerHTML = body;
  el.detail.hidden = false;
  el.detailBackdrop.hidden = false;
}

function closeDetail() {
  el.detail.hidden = true;
  el.detailBackdrop.hidden = true;
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

  // Fill the add-form datalists (district_coords gives the canonical district list).
  const districtList = $('district-options');
  const sectorList = $('sector-options');
  if (districtList) fillDatalist(districtList, [...new Set([...Object.keys(COORDS), ...districts])].sort());
  if (sectorList) fillDatalist(sectorList, sectors);
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

function wireEvents() {
  el.search.addEventListener('input', render);
  el.district.addEventListener('change', render);
  el.sector.addEventListener('change', render);
  el.contacts.addEventListener('change', render);
  el.reset.addEventListener('click', () => {
    el.search.value = '';
    el.district.value = '';
    el.sector.value = '';
    el.contacts.checked = false;
    render();
  });

  el.detailClose.addEventListener('click', closeDetail);
  el.detailBackdrop.addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

  // Double click a list card opens detail; single click flies. Use a small delay.
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
  $('submit-btn').disabled = !clean;
  const hint = $('form-hint');
  if (hint) hint.textContent = clean ? 'Verified — no duplicates. You can add it.' : 'Verify first to enable Add.';
}

function invalidateVerification() {
  if (verifiedClean) setVerified(false);
}

function openAddModal() {
  $('modal-backdrop').hidden = false;
  $('add-modal').hidden = false;
  setVerified(false);
  const first = formEl('name');
  if (first) first.focus();
}

function closeAddModal() {
  $('add-modal').hidden = true;
  $('modal-backdrop').hidden = true;
}

function resetAddForm() {
  $('add-form').reset();
  clearFieldErrors();
  const vr = $('verify-result');
  vr.hidden = true;
  vr.innerHTML = '';
  setVerified(false);
}

function renderVerifyResult(payload) {
  const vr = $('verify-result');
  vr.hidden = false;

  if (payload.errors && Object.keys(payload.errors).length) {
    showFieldErrors(payload.errors);
    vr.className = 'verify-result bad';
    vr.textContent = 'Please fix the highlighted fields.';
    setVerified(false);
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
  } else {
    vr.className = 'verify-result good';
    vr.innerHTML = '<div class="vr-title">✓ No duplicates found — clear to add.</div>';
    setVerified(true);
  }
}

async function verifyStartup() {
  const btn = $('verify-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/startups/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectForm()),
    });
    const payload = await res.json();
    renderVerifyResult(payload);
  } catch (err) {
    console.error('verify failed:', err);
    const vr = $('verify-result');
    vr.hidden = false;
    vr.className = 'verify-result bad';
    vr.textContent = API_AVAILABLE
      ? 'Could not reach the verify service. Check the server and try again.'
      : 'Verification needs the Node server (node server.js). It is not available in static mode.';
    setVerified(false);
  } finally {
    btn.disabled = false;
  }
}

async function submitStartup(ev) {
  ev.preventDefault();
  if (!verifiedClean) {
    toast('Verify the record before adding.', 'bad');
    return;
  }
  const btn = $('submit-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/startups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectForm()),
    });
    const payload = await res.json();

    if (res.status === 201 && payload.record) {
      insertRecord(payload.record);
      toast(`Added “${payload.record.name}” to the directory.`, 'good');
      closeAddModal();
      resetAddForm();
    } else if (res.status === 409) {
      renderVerifyResult({ duplicate: true, matches: payload.matches || [] });
      toast('That startup is already listed.', 'bad');
    } else if (res.status === 400) {
      renderVerifyResult({ errors: payload.errors || {} });
      toast('Some fields need fixing.', 'bad');
    } else if (res.status === 403) {
      toast('Adding is not permitted from this location (admin token required).', 'bad');
    } else {
      toast('Could not add the startup. Please try again.', 'bad');
    }
  } catch (err) {
    console.error('add failed:', err);
    toast(API_AVAILABLE ? 'Network error while adding.' : 'Adding needs the Node server (node server.js).', 'bad');
  } finally {
    btn.disabled = !verifiedClean;
  }
}

// Insert a newly created record into the live map/list without a full reload.
function insertRecord(record) {
  const rec = userToRecord(record, STARTUPS.length);
  assignCoords(rec);
  STARTUPS.push(rec);

  const counts = {};
  for (const s of STARTUPS) counts[s.district] = (counts[s.district] || 0) + 1;
  const marker = makeMarker(rec, counts[rec.district]);
  if (clusterGroup) clusterGroup.addLayer(marker);

  populateFilters();
  render();
}

function toast(message, kind = 'info') {
  const region = $('toast-region');
  if (!region) return;
  const node = document.createElement('div');
  node.className = 'toast ' + kind;
  node.textContent = message;
  region.appendChild(node);
  setTimeout(() => { node.classList.add('show'); }, 10);
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 300);
  }, 4200);
}

function wireAddStartup() {
  $('add-startup').addEventListener('click', openAddModal);
  $('add-close').addEventListener('click', closeAddModal);
  $('modal-backdrop').addEventListener('click', closeAddModal);
  $('verify-btn').addEventListener('click', verifyStartup);
  $('add-form').addEventListener('submit', submitStartup);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('add-modal').hidden) closeAddModal();
  });
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
  try {
    await loadData();
    populateFilters();
    initMap();
    wireEvents();
    wireAddStartup();
    render();
  } catch (err) {
    console.error('Failed to initialize MP Startup Map:', err);
    el.loading.textContent = 'Failed to load data. Serve this folder over HTTP (see README) and reload.';
    return;
  }
  el.loading.classList.add('hidden');
})();
