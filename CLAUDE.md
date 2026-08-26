# Project: MP Startup Map — Interactive Directory

## What this is
A single-page interactive web app mapping Madhya Pradesh (India) tech startups on a Leaflet map, with a searchable/filterable list and company detail cards.

## Data (DO NOT invent data — use these files)
- `data/tech_registry.json` — 656 DPIIT-registered tech startups. Each row: [name, dipp_no, sector, industry, district]. No coords — geocode by district centroid (see `data/district_coords.json`).
- `data/enriched.json` — 80 companies with contact dossiers: website, public email, phone, founders, LinkedIn, careers URL, city, description. Fields may be "not publicly listed" — render them as such, never fabricate.
- District centroids for map placement must be real lat/lng of MP district HQs. Include all districts appearing in the registry (Indore 22.72, Bhopal 23.26, Jabalpur 23.17, Gwalior 26.22, Ujjain 23.18, etc.). Add slight deterministic jitter per startup so pins don't perfectly overlap.

## Features (required)
1. **Leaflet map** (OpenStreetMap tiles) centered on MP (23.5, 78.5, zoom 6). Circle/pin markers sized by district startup count. Popups: name, sector, district, website link, email/phone if available.
2. **Search box** — filters by name, sector, industry, district (case-insensitive, live).
3. **Filters** — district dropdown, sector dropdown, "has contacts only" toggle.
4. **Split view** — map left (~60%), list right; clicking a list item flies the map to its pin and opens the popup; clicking a pin highlights the list entry.
5. **Detail panel** — for enriched (80) companies show full dossier: description, founders, email, phone, LinkedIn, careers. For registry-only companies show registry fields + "contact details not yet researched".
6. **Stats bar** — total shown, districts, sectors after filtering.
7. **Dark, modern UI** — clean sans-serif, MP-themed accent color, responsive (mobile: tabs for map/list).
8. **Careers links open in new tab** (rel="noopener").

## Tech constraints
- Single `index.html` + `app.js` + `style.css` + `data/*.json`. No build step, no frameworks, vanilla JS. Leaflet via CDN (unpkg). Works offline except tiles.
- All data loaded via `fetch('./data/...')` — so it must be served over HTTP (python -m http.server). Include a README with the run command.
- Keep JSON loading resilient: if enriched.json fails, app still works with registry data.

## Quality bar
- No console errors on load.
- Handles 656 markers smoothly (use canvas renderer or marker clustering via leaflet.markercluster CDN).
- Empty-state message when filters match nothing.
