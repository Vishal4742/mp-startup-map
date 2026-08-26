# MP Startup Map

An interactive directory of Madhya Pradesh tech startups. It plots 656 DPIIT-registered
startups on a Leaflet map, adds contact dossiers for the notable ones, and gives you live
search, filters, a linked list, and per-company detail cards.

## Run it

The app loads its data with `fetch('./data/...')`, so it has to be served over HTTP — opening
`index.html` from disk won't work. From this folder:

```bash
python -m http.server 8000
```

Then open http://localhost:8000 in your browser.

Any static server works (`npx serve`, `php -S localhost:8000`, etc.). Map tiles need an
internet connection; everything else runs offline.

## What's on screen

- **Map (left):** OpenStreetMap tiles centered on MP. Startups are clustered so all 656 pins
  stay responsive. Green pins have a contact dossier; orange pins are registry-only. Click a
  pin for a popup, or "Full details →" for the full card.
- **List (right):** every startup matching the current filters. Click a row to fly the map to
  its pin and open the popup; double-click for the detail drawer.
- **Search:** live, case-insensitive, across name, sector, industry, and district.
- **Filters:** district dropdown, sector dropdown, and a "has contacts only" toggle.
- **Stats bar:** shown count, districts, sectors, and how many have contacts — all after filtering.
- **Detail drawer:** full dossier (description, founders, email, phone, LinkedIn, careers,
  sources) for enriched companies; registry fields plus a "not yet researched" note otherwise.
- **Mobile:** the split view becomes Map / List tabs.

## Data

Everything comes from `data/` — nothing is fabricated:

- `tech_registry.json` — 656 DPIIT-registered startups: `[name, dipp_no, sector, industry, district]`.
- `enriched.json` — 80 contact dossiers. Some fields read "not publicly listed"; those render as-is.
- `district_coords.json` — real lat/lng of MP district HQs, used to place pins (with a small
  deterministic jitter per startup so co-located pins don't overlap).

Dossiers are matched to registry rows by DIPP number or company name; the rest are shown as
standalone notable startups placed by their listed city. Missing fields are never invented.

## Tech

Single `index.html` + `app.js` + `style.css`, vanilla JS, no build step. Leaflet and
Leaflet.markercluster load from the unpkg CDN.
