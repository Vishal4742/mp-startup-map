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

async function loadData() {
  // Registry + coords are required; enriched is optional (resilient).
  const [registry, coords] = await Promise.all([
    fetch('./data/tech_registry.json').then((r) => r.json()),
    fetch('./data/district_coords.json').then((r) => r.json()),
  ]);
  COORDS = coords;
  DISTRICT_NAMES = Object.keys(coords).sort((a, b) => b.length - a.length);

  let enriched = [];
  try {
    enriched = await fetch('./data/enriched.json').then((r) => r.json());
  } catch (e) {
    console.warn('enriched.json unavailable — continuing with registry data only.');
  }

  // Index registry by DIPP and by normalized name for matching dossiers.
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
    if (rec.dipp) byDipp.set(rec.dipp.toUpperCase(), rec);
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
      // Standalone notable startup not in the DPIIT registry rows.
      const cityText = e.City || company;
      const district = districtFromText(cityText) || 'Indore'; // registry_gems w/o city are Indore-based
      records.push({
        id: 's' + standaloneIdx++,
        name: company.replace(/\s*\(DIPP\d+\)/i, '').trim(),
        dipp: dippMatch || '',
        sector: '',           // enriched has no registry sector; derive a label below
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

  STARTUPS = records;

  // Assign map coordinates (district centroid + deterministic jitter).
  for (const rec of STARTUPS) {
    const base = COORDS[rec.district] || MP_CENTER;
    const [jx, jy] = hashJitter(rec.id + rec.name);
    rec.lat = base[0] + jx;
    rec.lng = base[1] + jy;
  }
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
    const radius = 5 + Math.min(11, Math.log2(count + 1) * 2.2);
    const marker = L.circleMarker([s.lat, s.lng], {
      radius,
      color: s.hasContacts ? '#4ade80' : '#ff8f3f',
      weight: 1.5,
      fillColor: s.hasContacts ? '#4ade80' : '#ff8f3f',
      fillOpacity: 0.55,
    });
    marker.bindPopup(popupHtml(s), { maxWidth: 280 });
    marker.on('click', () => {
      setActive(s.id, false);
    });
    marker._recId = s.id;
    markerById.set(s.id, marker);
    clusterGroup.addLayer(marker);
  }

  map.addLayer(clusterGroup);

  // Delegated handler for the "Full details" link inside popups.
  map.on('popupopen', (ev) => {
    const node = ev.popup.getElement();
    const more = node && node.querySelector('.popup-more');
    if (more) more.addEventListener('click', () => openDetail(more.getAttribute('data-id')));
  });
}

function popupHtml(s) {
  const web = s.enriched ? firstUrl(s.enriched.Website) : null;
  const email = s.enriched ? firstEmail(s.enriched['Public contact email']) : null;
  const phoneRaw = s.enriched && !isMissing(s.enriched['Public phone']) ? s.enriched['Public phone'] : null;

  let links = '';
  if (web) links += `<a href="${escapeHtml(web)}" target="_blank" rel="noopener">🌐 ${escapeHtml(web.replace(/^https?:\/\//, ''))}</a>`;
  if (email) links += `<a href="mailto:${escapeHtml(email)}">✉️ ${escapeHtml(email)}</a>`;
  if (phoneRaw) links += `<a href="tel:${escapeHtml(String(phoneRaw).replace(/[^\d+]/g, ''))}">📞 ${escapeHtml(phoneRaw)}</a>`;

  return `
    <div class="popup-title">${escapeHtml(s.name)}</div>
    <div class="popup-meta">${escapeHtml(s.sector || '—')}${s.industry ? ' · ' + escapeHtml(s.industry) : ''}</div>
    <div class="popup-meta">📍 ${escapeHtml(s.district)}</div>
    ${links ? `<div class="popup-links">${links}</div>` : ''}
    <span class="popup-more" data-id="${s.id}">Full details →</span>
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
  if (window.innerWidth <= 820) document.body.classList.remove('show-list');

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
    const url = firstUrl(value) || value;
    html = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(value)}</a>`;
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
  for (const d of districts) {
    const o = document.createElement('option');
    o.value = d; o.textContent = d;
    el.district.appendChild(o);
  }
  for (const s of sectors) {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    el.sector.appendChild(o);
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
// Boot
// ============================================================

(async function main() {
  try {
    await loadData();
    populateFilters();
    initMap();
    wireEvents();
    render();
  } catch (err) {
    console.error('Failed to initialize MP Startup Map:', err);
    el.loading.textContent = 'Failed to load data. Serve this folder over HTTP (see README) and reload.';
    return;
  }
  el.loading.classList.add('hidden');
})();
