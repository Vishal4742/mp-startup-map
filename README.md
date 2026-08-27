# MP Startup Map

[![CI](https://github.com/Vishal4742/mp-startup-map/actions/workflows/ci.yml/badge.svg)](https://github.com/Vishal4742/mp-startup-map/actions/workflows/ci.yml)
**Live:** https://mp-startup-map.vercel.app (static build — map, search, filters, details; adding startups needs the local Node server)

An interactive directory of Madhya Pradesh startups. It plots every DPIIT-recognised startup in
the state (about 8,000) on a Leaflet map (the registry is refreshed automatically from the Startup
India portal — see *Data pipeline*), adds contact dossiers for the notable ones, and
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
- `MP_ADMIN_TOKEN` — when set, **every** write (`POST /api/startups`) must carry a matching
  `X-Admin-Token` header, loopback included (see safety policy)
- `MP_ALLOWED_HOSTS` — comma-separated extra hostnames accepted in the `Host` header
  (defaults already allow `localhost`, `127.0.0.1`, `::1`). Set this only when you
  intentionally serve the app under another hostname.
- `NODE_ENV=test` — silences request-error logging (the test suite sets this itself).

`package.json` scripts: `npm start`, `npm test`, `npm run check`.

### Static-only (map + search + filters, no Add)

The frontend still works from any plain static server; it falls back to the raw JSON files
when the API is unavailable (the Add / Verify features need the Node server):

```bash
python -m http.server 8000
```

Map tiles and the Leaflet libraries (loaded from the unpkg CDN) need an internet
connection; the data and the API run locally.

## API

All endpoints are same-origin only and send strict security headers (CSP, `X-Content-Type-Options`,
`Referrer-Policy`, `frame-ancestors 'none'`). Every request is also checked against a **Host
allowlist** (`localhost` / `127.0.0.1` / `::1`, plus any `MP_ALLOWED_HOSTS`) before routing — a
request carrying an unexpected `Host` header is rejected with `403` to blunt DNS-rebinding.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/health` | Liveness: `{ ok: true, ... }` |
| GET  | `/api/startups` | Combined data: `{ registry[], enriched[], user[], coords, meta }` (`meta` = registry provenance) |
| GET  | `/api/startups/check?name=&website=&dipp=` | Duplicate check; `{ duplicate, matches, checks }` |
| POST | `/api/startups/verify` | Validate + duplicate-check a proposed record (no write) |
| POST | `/api/startups` | Validate, re-check, and persist a new record → `201 { record }` |

Duplicate matching is authoritative and offline (no outbound requests — no SSRF): it compares
the **normalized name**, the **official website hostname**, and the **case-insensitive DPIIT
number** against the registry, enriched dossiers, and previously-added user records.

Validation on write: JSON body ≤ 64 KiB, `application/json` only, strict per-field length
limits, `district` canonicalised onto the known MP district list — case-insensitive, and a district
named as a whole word inside the text counts (`Pithampur, Dhar` → `Dhar`; `Dharwad` does not) — with
anything else a `400`,
`http`/`https` URLs only, conservative email/phone formats, and a small per-IP rate
limit. Every failure is a JSON envelope with an `error` code (`validation_failed`, `duplicate`,
`rate_limited`, `write_forbidden`, `not_found`, …). The limiter covers every non-trivial endpoint — `GET /api/startups` (which serializes the
full dataset and reads the user file on each call), the check/verify endpoints, and the write —
returning `429` past the limit and recovering after the window. The rate-limit table prunes expired
entries as it grows, so it stays bounded. The read-check-persist path for `POST /api/startups` is serialized
by an in-process mutex, so two concurrent submissions can't lose each other's write or both slip
the same identity past the duplicate check.

**Static serving is deliberately narrow.** The Node server only serves the public app shell —
`/` (→ `index.html`), `/app.js`, and `/style.css`. Everything else (`server.js`, `package.json`,
`tests/`, `.git/`, docs, config, and `data/*.json`) returns a JSON `404`, and path traversal stays
`403`/`404`. The frontend gets its data from the API (`/api/startups`) — including the district
centroids, returned as `coords`, since `data/district_coords.json` is locked down too — not from
static `data/*.json`; the pure-static fallback (`python -m http.server`, which *does* serve the
JSON) is only for running without the Node backend.

## Persistence

Accepted submissions are appended to `data/user_startups.json` using an atomic temp-file +
`rename` write (a missing, empty, or corrupt file is recovered as `[]`). This file is runtime
data and is git-ignored; the source `tech_registry.json`, `enriched.json`, and
`district_coords.json` are never modified.

## Safety policy (local-only) — read before deploying

The write route (`POST /api/startups`) picks its policy from whether `MP_ADMIN_TOKEN` is set:

- **Token configured (`MP_ADMIN_TOKEN` set):** every write — **including loopback** — must send a
  matching `X-Admin-Token` header (compared timing-safely). Loopback gets **no** bypass, so a
  same-host reverse proxy forwarding public traffic (which arrives as `127.0.0.1`) cannot slip a
  write past auth. A missing or wrong token is `403 { reason: "bad-token" }`. The token is never
  echoed back in any response. Read-only routes — including `GET /api/startups` and
  `POST /api/startups/verify` — never require the token.
- **No token configured (local prototype):** loopback (`127.0.0.1` / `::1`) may write freely for
  local convenience; every non-loopback request is refused (`403`).

The Add-startup form has a transient **Admin token** field: it is sent only as `X-Admin-Token` on
the submission request and is never stored in the record or the schema. Leave it blank for local
(no-token) use.

> **Deployment warning:** If you host this beyond localhost, set a strong `MP_ADMIN_TOKEN` so
> loopback carries no write privilege, bind carefully, keep it behind an authenticated reverse
> proxy, and treat every submission as untrusted. With no token set the loopback-write convenience
> is for local use only — do **not** expose that mode to the public internet.

Only submit **publicly listed, official business** information (company website, business
email/phone, public founder names). Never enter private personal contact details.

## What's on screen

- **Map (home screen, full width):** OpenStreetMap tiles centered on MP; one clustered pin per startup — every
  registry row plus the dossier-only companies. Green = has public
  contact details (a linkable website, email or phone), orange = none listed yet, blue =
  community-added. Click a pin for a popup or "Full details →".
- **List (toggled panel):** opened with the **List** button in the controls bar — a side panel on
  desktop, a full overlay on mobile (remembered between visits; typing a search opens it). It shows
  every startup matching the filters — 200 at a time with a **Show more** button — with a count and a sort (district,
  name A–Z, contacts first). Registry names are shown title-cased with the legal suffix
  de-emphasised (the raw name is still what search matches); the card's left edge carries the
  same colour as its pin. Click to fly to the pin; double-click for the detail drawer. Cards are
  keyboard-selectable (`role="button"`, focusable): **Enter** opens the detail drawer, **Space**
  locates the pin on the map. The drawer has **Show on map** and, when known, **Website**.
- **Search / filters / stats:** live search across name, sector, industry, district (press
  **/** to jump to the search box); district, industry and sector dropdowns; "has contacts only" toggle;
  live stats bar; Reset is enabled only while a filter is active, and the empty state offers
  **Clear filters**. A legend in the map corner explains the pin colours.
- **Loading / errors:** card-shaped skeletons keep the layout stable while data loads; a
  failed load shows the reason and a **Try again** button instead of a blank screen.
- **Add startup:** a prominent toolbar button opens an accessible modal form (district must be
  a Madhya Pradesh district from the list; city/town is optional). **Verify in directory** runs
  the duplicate check and shows the exact reasons — or the server's actual refusal (rate limit,
  host guard, …); **Add** stays disabled until verification passes with no duplicate. A successful add drops the record straight into
  the live map, list, and stats — no reload — and shows a toast.
- **Mobile:** the map takes most of the screen — the stats become one compact line, the filters
  collapse behind a **Filters** button (search and **List** stay on top), inputs are 16 px (no
  iOS zoom) with ≥40 px targets, the list panel covers the map and closes when you pick a startup,
  and the add form and detail drawer go full-screen.

## Data model

- `tech_registry.json` — DPIIT-recognised startups: `[name, dipp_no, sector, industry, district]`,
  generated by the data pipeline below (`registry_meta.json` records when and how).
- `enriched.json` — curated dossiers (80 today): `Company`, `City` (or `District` — the `_batch: "registry_gems"`
  rows carry their location there instead), `What they build`, `Website`, `Public contact email`,
  `Public phone`, `Founder(s)`, `LinkedIn URL`, `Careers URL`, `Source`, plus bookkeeping keys
  `#` and `_batch`. `Company` strings look like `Legal Name / Brand (DIPPnnnnn)`; `Website` may
  hold several URLs or a bare domain (`skylanedrone.com`); `Public phone` may list several
  numbers with notes — the UI links the first.
- `district_coords.json` — real lat/lng of MP district HQs, generated from
  `data/district_coords.py` (`python3 data/district_coords.py > data/district_coords.json`);
  pins get a small deterministic jitter so co-located ones don't overlap.
- `user_startups.json` (generated) — added records: `id`, `name`, `dipp`, `district` (canonical
  MP district), `city` (optional town), `sector`, `industry`, `description`, `website`, `email`,
  `phone`, `founders`, `linkedin`, `careers`, `sources`, `source: "user"`, `createdAt`. Only
  official/public business contact channels are stored — there are no private-contact fields in
  the schema.

Placeholder dossier values ("Not publicly listed (…)", "n/a", "Not applicable", "No active
website found …") render muted as *not publicly listed*. Nothing is fabricated.

## Data pipeline

The registry is not typed in by hand any more: `scripts/fetch-startupindia.mjs` pulls it from the
public directory on the Startup India portal (`POST /sih/api/noauth/search/profiles`, the same
request the portal's own search page makes), keeps DPIIT-recognised startups of the chosen state,
maps each city onto a district with the shared normaliser, de-duplicates by DIPP number and writes
`data/tech_registry.json` plus `data/registry_meta.json` (source, time, counts, filter, unmapped
cities). Zero dependencies, ~4 requests/second with retries.

```bash
npm run data:refresh                                        # Madhya Pradesh, every industry
node scripts/fetch-startupindia.mjs --all --state "Goa"     # another state
node scripts/fetch-startupindia.mjs --all --max-pages 5     # quick sample
node scripts/fetch-startupindia.mjs --all --raw-out data/registry_raw.json   # keep the raw records too
node scripts/fetch-startupindia.mjs --all --raw-in data/registry_raw.json    # re-map offline
```

`data/city_districts.json` maps towns the portal lists as "city" (Pithampur, Mhow, Nagda…) onto
their districts; add a line there when the refresh reports an unmapped city.

`.github/workflows/refresh-data.yml` runs it every Monday (and on demand from the Actions tab),
runs the tests against the new data and commits the change; the push deploys to Vercel through
the Git integration. The map's attribution shows the source and the refresh date. The contact
dossiers (`enriched.json`) are still curated by hand — automating them (web search + extraction
with an LLM) is the next step.

## Sharing and deploying

- **Links carry state.** Filters, sort and the open startup live in the URL hash
  (`#district=Indore&sort=name&id=r12`), so any view can be copied from the address bar.
- **CI** (`.github/workflows/ci.yml`) runs the backend tests, the frontend contract check and
  the coordinate-generator diff on Node 18, 20, 22 and 24 for every push and pull request.
- **Vercel** hosts the static build at https://mp-startup-map.vercel.app; the project is linked to
  this GitHub repository, so every push to `main` deploys to production and every pull request gets
  a preview URL (`vercel.json` holds the build step and security headers).
- **GitHub Pages** (`.github/workflows/pages.yml`) publishes the static build — map, search,
  filters and details, but no Add/Verify, so the Add button is hidden there. Enable it once
  (Settings → Pages → Source: *GitHub Actions*; on a free plan the repository must be public),
  then run the *Deploy to GitHub Pages* workflow from the Actions tab.

## Testing

```bash
npm test          # tests/normalize.test.js + tests/server.test.js + tests/app.test.js (node:test, no deps)
npm run check     # syntax check + scripts/check-frontend.mjs (IDs, endpoints, security attrs)
```

`tests/app.test.js` loads `app.js` into a Node vm with a stub DOM and exercises its logic
(name display, contact detection, the dossier merge, sorting) against the real data files.

The tests copy the source JSON into a temp directory (removed afterwards), never touch real
data, and ignore any `MP_ADMIN_TOKEN` / `MP_ALLOWED_HOSTS` in your shell.

## Tech

Single `index.html` + `app.js` + `style.css` + `server.js`, vanilla JS, no build step and no
runtime dependencies. Leaflet and Leaflet.markercluster load from the unpkg CDN.
`shared/normalize.js` holds the name / DPIIT / district / URL normalisation rules once, for
both the browser (`window.MPNormalize`) and the server (`require`), so the map and the
duplicate check can never disagree.
