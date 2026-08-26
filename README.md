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
- `MP_ADMIN_TOKEN` — when set, **every** write (`POST /api/startups`) must carry a matching
  `X-Admin-Token` header, loopback included (see safety policy)
- `MP_ALLOWED_HOSTS` — comma-separated extra hostnames accepted in the `Host` header
  (defaults already allow `localhost`, `127.0.0.1`, `::1`). Set this only when you
  intentionally serve the app under another hostname.

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
`Referrer-Policy`, `frame-ancestors 'none'`). Every request is also checked against a **Host
allowlist** (`localhost` / `127.0.0.1` / `::1`, plus any `MP_ALLOWED_HOSTS`) before routing — a
request carrying an unexpected `Host` header is rejected with `403` to blunt DNS-rebinding.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/health` | Liveness: `{ ok: true, ... }` |
| GET  | `/api/startups` | Combined data: `{ registry[656], enriched[80], user[], coords }` |
| GET  | `/api/startups/check?name=&website=&dipp=` | Duplicate check; `{ duplicate, matches, checks }` |
| POST | `/api/startups/verify` | Validate + duplicate-check a proposed record (no write) |
| POST | `/api/startups` | Validate, re-check, and persist a new record → `201 { record }` |

Duplicate matching is authoritative and offline (no outbound requests — no SSRF): it compares
the **normalized name**, the **official website hostname**, and the **case-insensitive DPIIT
number** against the registry, enriched dossiers, and previously-added user records.

Validation on write: JSON body ≤ 64 KiB, `application/json` only, strict per-field length
limits, `http`/`https` URLs only, conservative email/phone formats, and a small per-IP rate
limit. The limiter covers every non-trivial endpoint — `GET /api/startups` (which serializes the
full dataset and reads the user file on each call), the check/verify endpoints, and the write —
returning `429` past the limit and recovering after the window. The rate-limit table prunes expired
entries as it grows, so it stays bounded. The read-check-persist path for `POST /api/startups` is serialized
by an in-process mutex, so two concurrent submissions can't lose each other's write or both slip
the same identity past the duplicate check.

**Static serving is deliberately narrow.** The Node server only serves the public app shell —
`/` (→ `index.html`), `/app.js`, and `/style.css`. Everything else (`server.js`, `package.json`,
`tests/`, `.git/`, task files, and `data/*.json`) returns `404`, and path traversal stays
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

- **Map (left):** OpenStreetMap tiles centered on MP; 656 clustered pins. Green = has a
  dossier, orange = registry-only, blue = community-added. Click a pin for a popup or
  "Full details →".
- **List (right):** every startup matching the filters. Click to fly to its pin; double-click
  for the detail drawer. Cards are keyboard-selectable (`role="button"`, focusable): **Enter**
  opens the detail drawer, **Space** locates the pin on the map.
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
