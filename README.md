# MP Startup Map

An interactive, locally-hosted directory of Madhya Pradesh tech startups. It plots 656
DPIIT-registered startups on a Leaflet map, adds contact dossiers for the notable ones, and
lets you add new startups through a duplicate-checked submission form — all backed by a
zero-dependency Node.js server.

## Run it

### With the Node server (full platform — map + API + Add startup)

Node 18+ only, no `npm install` needed:

```bash
node server.js
```

Then open http://localhost:8000. The server serves the frontend and the JSON API from the
same origin.

Optional environment:

- `PORT` — listen port (default `8000`)
- `HOST` — bind address (default `127.0.0.1`, loopback only)
- `MP_ADMIN_TOKEN` — required token for **non-loopback** write requests (see safety policy)

`package.json` scripts: `npm start`, `npm test`, `npm run check`.

### Static-only (map + search + filters, no Add)

The frontend still works from any plain static server; it falls back to the raw JSON files
when the API is unavailable (the Add / Verify features need the Node server):

```bash
python -m http.server 8000
```

Map tiles need an internet connection; everything else runs offline.

## API

All endpoints are same-origin only and send strict security headers (CSP, `X-Content-Type-Options`,
`Referrer-Policy`, `frame-ancestors 'none'`).

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/health` | Liveness: `{ ok: true, ... }` |
| GET  | `/api/startups` | Combined data: `{ registry[656], enriched[80], user[] }` |
| GET  | `/api/startups/check?name=&website=&dipp=` | Duplicate check; `{ duplicate, matches, checks }` |
| POST | `/api/startups/verify` | Validate + duplicate-check a proposed record (no write) |
| POST | `/api/startups` | Validate, re-check, and persist a new record → `201 { record }` |

Duplicate matching is authoritative and offline (no outbound requests — no SSRF): it compares
the **normalized name**, the **official website hostname**, and the **case-insensitive DPIIT
number** against the registry, enriched dossiers, and previously-added user records.

Validation on write: JSON body ≤ 64 KiB, `application/json` only, strict per-field length
limits, `http`/`https` URLs only, conservative email/phone formats, and a small per-IP rate
limit on the check/verify/write endpoints.

## Persistence

Accepted submissions are appended to `data/user_startups.json` using an atomic temp-file +
`rename` write (a missing, empty, or corrupt file is recovered as `[]`). This file is runtime
data and is git-ignored; the source `tech_registry.json`, `enriched.json`, and
`district_coords.json` are never modified.

## Safety policy (local-only) — read before deploying

This is a **local prototype**. The write route (`POST /api/startups`) uses this policy:

- **Loopback requests** (`127.0.0.1` / `::1`) may write freely — the local prototype mode.
- **Non-loopback requests** must send a matching `X-Admin-Token` header equal to
  `MP_ADMIN_TOKEN`. Without the env var set, all remote writes are refused (`403`). The token
  is never echoed back in any response.

> **Deployment warning:** Do **not** expose the unauthenticated write route to the public
> internet. If you must host this beyond localhost, bind carefully, set a strong
> `MP_ADMIN_TOKEN`, put it behind an authenticated reverse proxy, and treat every submission
> as untrusted. The loopback-write convenience exists purely for local use.

Only submit **publicly listed, official business** information (company website, business
email/phone, public founder names). Never enter private personal contact details.

## What's on screen

- **Map (left):** OpenStreetMap tiles centered on MP; 656 clustered pins. Green = has a
  dossier, orange = registry-only, blue = community-added. Click a pin for a popup or
  "Full details →".
- **List (right):** every startup matching the filters. Click to fly to its pin; double-click
  for the detail drawer.
- **Search / filters / stats:** live search across name, sector, industry, district; district
  and sector dropdowns; "has contacts only" toggle; live stats bar.
- **Add startup:** a prominent toolbar button opens an accessible modal form. **Verify in
  directory** runs the duplicate check and shows the exact reasons; **Add** stays disabled
  until verification passes with no duplicate. A successful add drops the record straight into
  the live map, list, and stats — no reload — and shows a toast.
- **Mobile:** the split view becomes Map / List tabs; the form collapses to a single column.

## Data model

- `tech_registry.json` — 656 DPIIT startups: `[name, dipp_no, sector, industry, district]`.
- `enriched.json` — 80 dossiers: `Company`, `City`, `What they build`, `Website`,
  `Public contact email`, `Public phone`, `Founder(s)`, `LinkedIn URL`, `Careers URL`, `Source`.
- `district_coords.json` — real lat/lng of MP district HQs; pins get a small deterministic
  jitter so co-located ones don't overlap.
- `user_startups.json` (generated) — added records: `id`, `name`, `dipp`, `district`, `city`,
  `sector`, `industry`, `description`, `website`, `email`, `phone`, `founders`, `linkedin`,
  `careers`, `sources`, `source: "user"`, `createdAt`. Only official/public business contact
  channels are stored — there are no private-contact fields in the schema.

Missing dossier fields read "not publicly listed" and render as-is. Nothing is fabricated.

## Testing

```bash
node --test tests/server.test.js     # backend suite (node:test, no deps)
node scripts/check-frontend.mjs      # frontend contract check (IDs, endpoints, security attrs)
node --check server.js && node --check app.js
```

The tests copy the source JSON into a temp directory and never touch real data.

## Tech

Single `index.html` + `app.js` + `style.css` + `server.js`, vanilla JS, no build step and no
runtime dependencies. Leaflet and Leaflet.markercluster load from the unpkg CDN.
