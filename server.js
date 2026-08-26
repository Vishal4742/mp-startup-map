'use strict';

/*
 * MP Startup Map — dependency-free local platform server.
 *
 * Node built-ins only. Serves the static frontend and a small JSON API for
 * browsing the directory and submitting new (public, business-only) startup
 * records. Designed for LOCAL prototype use — see README for the deployment
 * warning about the unauthenticated write route.
 *
 * Exports createAppServer(options) which returns a non-listening http.Server,
 * plus the pure helpers used by the test suite.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;

// ============================================================
// Pure helpers (exported for testing)
// ============================================================

// Mirror of the frontend normName so name matching is consistent both ways.
function normalizeName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .split('(')[0].split('/')[0].split('→')[0]
    .replace(/private limited|pvt\.? ?ltd\.?|llp|limited|technologies|technology/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Return the bare hostname (lowercase, no www.) for an http/https URL, else null.
function normalizeHostname(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.hostname.toLowerCase().replace(/^www\./, '') || null;
}

// Extract every http/https hostname from a free-text field (enriched Website can
// hold multiple URLs, e.g. "https://a.com (parent: https://b.com)").
function extractHostnames(text) {
  const out = [];
  const re = /https?:\/\/[^\s,()<>"']+/gi;
  const str = String(text == null ? '' : text);
  let m;
  while ((m = re.exec(str)) !== null) {
    const h = normalizeHostname(m[0]);
    if (h) out.push(h);
  }
  return out;
}

function normalizeDipp(s) {
  return String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '');
}

// Extract the bare hostname (lowercase, no port, no IPv6 brackets) from a
// Host header value, or '' if it cannot be parsed.
function hostnameFromHost(hostHeader) {
  const s = String(hostHeader == null ? '' : hostHeader).trim();
  if (!s) return '';
  let hostname;
  try {
    hostname = new URL('http://' + s).hostname;
  } catch {
    return '';
  }
  return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

// DNS-rebinding guard: is the request's Host header on the allowlist? The
// allowlist holds bare hostnames (no port); the port is ignored on comparison.
function hostAllowed(hostHeader, allowedHosts) {
  const hostname = hostnameFromHost(hostHeader);
  if (!hostname) return false;
  return allowedHosts.includes(hostname);
}

function isLoopback(addr) {
  if (!addr) return false;
  const a = String(addr);
  return (
    a === '127.0.0.1' ||
    a === '::1' ||
    a === '::ffff:127.0.0.1' ||
    a.startsWith('127.') ||
    a.startsWith('::ffff:127.')
  );
}

// Decide whether a mutating request may write. Loopback is always allowed in
// local prototype mode; a non-loopback caller must present the admin token.
function writeAllowed({ remoteAddress, adminToken, providedToken } = {}) {
  if (isLoopback(remoteAddress)) return { allowed: true, reason: 'loopback' };
  if (!adminToken) return { allowed: false, reason: 'remote-no-token-configured' };
  if (providedToken && timingSafeEqual(providedToken, adminToken)) {
    return { allowed: true, reason: 'admin-token' };
  }
  return { allowed: false, reason: 'bad-token' };
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------

const LIMITS = {
  name: 200,
  dipp: 20,
  district: 80,
  city: 80,
  sector: 100,
  industry: 100,
  description: 2000,
  website: 300,
  email: 200,
  phone: 40,
  founders: 300,
  linkedin: 300,
  careers: 300,
  sources: 2000,
};

// Conservative, deliberately strict patterns. Business/public contacts only.
const EMAIL_RE = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$/i;
const PHONE_RE = /^[+()\-\s\d]{6,40}$/;
const DIPP_RE = /^DIPP\d{3,10}$/;

function str(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

// Validate a raw proposed record. Returns { valid, errors, candidate }.
function validateCandidate(input) {
  const errors = {};
  const src = input && typeof input === 'object' ? input : {};

  const c = {
    name: str(src.name),
    dipp: normalizeDipp(src.dipp),
    district: str(src.district),
    city: str(src.city),
    sector: str(src.sector),
    industry: str(src.industry),
    description: str(src.description),
    website: str(src.website),
    email: str(src.email),
    phone: str(src.phone),
    founders: str(src.founders),
    linkedin: str(src.linkedin),
    careers: str(src.careers),
    sources: str(src.sources),
  };

  // Required
  if (!c.name) errors.name = 'Startup name is required.';
  if (!c.district) errors.district = 'City / district is required.';
  if (!c.sector) errors.sector = 'Sector is required.';

  // Length limits
  for (const [field, max] of Object.entries(LIMITS)) {
    if (c[field] && c[field].length > max) {
      errors[field] = `Must be ${max} characters or fewer.`;
    }
  }

  // DPIIT number format (optional)
  if (c.dipp && !DIPP_RE.test(c.dipp)) {
    errors.dipp = 'DPIIT number should look like DIPP12345.';
  }

  // Safe URL fields (http/https only)
  for (const field of ['website', 'linkedin', 'careers']) {
    if (c[field] && !normalizeHostname(c[field])) {
      errors[field] = 'Enter a valid http(s) URL.';
    }
  }

  // Conservative email / phone
  if (c.email && !EMAIL_RE.test(c.email)) {
    errors.email = 'Enter a valid public business email.';
  }
  if (c.phone && !PHONE_RE.test(c.phone)) {
    errors.phone = 'Enter a valid public business phone number.';
  }

  return { valid: Object.keys(errors).length === 0, errors, candidate: c };
}

// ------------------------------------------------------------
// Duplicate detection
// ------------------------------------------------------------

// Build lightweight indexes from the three datasets.
function buildIndex(datasets) {
  const names = new Map();   // normName -> {source, name}
  const hosts = new Map();   // hostname -> {source, name}
  const dipps = new Map();   // DIPP -> {source, name}

  const addName = (n, entry) => { if (n && !names.has(n)) names.set(n, entry); };
  const addHost = (h, entry) => { if (h && !hosts.has(h)) hosts.set(h, entry); };
  const addDipp = (d, entry) => { if (d && !dipps.has(d)) dipps.set(d, entry); };

  for (const row of datasets.registry || []) {
    const [name, dipp] = row;
    const entry = { source: 'registry', name };
    addName(normalizeName(name), entry);
    if (dipp) addDipp(normalizeDipp(dipp), entry);
  }

  for (const e of datasets.enriched || []) {
    const company = e.Company || '';
    const entry = { source: 'enriched', name: company };
    for (const part of company.split(/[\/(]/)) addName(normalizeName(part), entry);
    addName(normalizeName(company), entry);
    const dippMatch = (company.match(/DIPP\d+/i) || [])[0];
    if (dippMatch) addDipp(normalizeDipp(dippMatch), entry);
    for (const h of extractHostnames(e.Website)) addHost(h, entry);
  }

  for (const u of datasets.user || []) {
    const entry = { source: 'user', name: u.name };
    addName(normalizeName(u.name), entry);
    if (u.dipp) addDipp(normalizeDipp(u.dipp), entry);
    const h = normalizeHostname(u.website);
    if (h) addHost(h, entry);
  }

  return { names, hosts, dipps };
}

// Authoritative duplicate check for a candidate against all datasets.
function duplicateCheck(candidate, datasets) {
  const idx = buildIndex(datasets);
  const checks = {
    name: normalizeName(candidate.name),
    hostname: normalizeHostname(candidate.website),
    dipp: normalizeDipp(candidate.dipp),
  };
  const matches = [];

  if (checks.name && idx.names.has(checks.name)) {
    const e = idx.names.get(checks.name);
    matches.push({ on: 'name', source: e.source, name: e.name, value: checks.name });
  }
  if (checks.hostname && idx.hosts.has(checks.hostname)) {
    const e = idx.hosts.get(checks.hostname);
    matches.push({ on: 'website', source: e.source, name: e.name, value: checks.hostname });
  }
  if (checks.dipp && idx.dipps.has(checks.dipp)) {
    const e = idx.dipps.get(checks.dipp);
    matches.push({ on: 'dipp', source: e.source, name: e.name, value: checks.dipp });
  }

  return { duplicate: matches.length > 0, matches, checks };
}

// ============================================================
// Server
// ============================================================

const MAX_BODY = 64 * 1024; // 64 KiB
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

// Only these public app assets are ever served statically. The data source is
// the API (/api/startups); server internals, tests, task files and data/*.json
// are never exposed. '/' maps to '/index.html'.
const STATIC_ALLOW = new Set(['/index.html', '/app.js', '/style.css']);

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function createAppServer(options = {}) {
  const dataDir = options.dataDir || path.join(ROOT, 'data');
  const staticDir = options.staticDir || ROOT;
  const adminToken = options.adminToken || process.env.MP_ADMIN_TOKEN || '';
  const rateCfg = options.rateLimit || { max: 60, windowMs: 60 * 1000 };
  const testRemoteHeader = options.testRemoteHeader || null; // test-only override

  // Host allowlist (DNS-rebinding guard). Loopback names are always allowed;
  // intentional deployments add hostnames via the allowedHosts option or the
  // MP_ALLOWED_HOSTS env var (comma-separated).
  const extraHosts = options.allowedHosts
    || String(process.env.MP_ALLOWED_HOSTS || '').split(',');
  const allowedHosts = [
    ...DEFAULT_ALLOWED_HOSTS,
    ...extraHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean),
  ];

  // How large the rate map may grow before expired entries are swept.
  const pruneAfter = Number(rateCfg.pruneAfter) > 0 ? Number(rateCfg.pruneAfter) : 5000;

  // Registry + enriched are immutable source data — load once.
  const registry = readJsonSafe(path.join(dataDir, 'tech_registry.json'), []);
  const enriched = readJsonSafe(path.join(dataDir, 'enriched.json'), []);
  const userFile = path.join(dataDir, 'user_startups.json');

  const rate = new Map(); // ip -> { count, resetAt }

  // Serializes the read-check-persist sequence of POST /api/startups so
  // concurrent writers can't lose each other's updates (in-process mutex).
  let writeChain = Promise.resolve();
  function withWriteLock(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => {}, () => {}); // keep the chain alive past errors
    return run;
  }

  function remoteAddressOf(req) {
    if (testRemoteHeader && req.headers[testRemoteHeader]) {
      return String(req.headers[testRemoteHeader]);
    }
    return req.socket.remoteAddress || '';
  }

  function rateLimited(ip) {
    const now = Date.now();
    let slot = rate.get(ip);
    if (!slot || now > slot.resetAt) {
      // Prune expired entries when the map grows so it can't grow unbounded.
      if (rate.size > pruneAfter) {
        for (const [k, v] of rate) if (now > v.resetAt) rate.delete(k);
      }
      slot = { count: 0, resetAt: now + rateCfg.windowMs };
      rate.set(ip, slot);
    }
    slot.count += 1;
    return slot.count > rateCfg.max;
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Never leak internals.
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
      if (process.env.NODE_ENV !== 'test') console.error('request error:', err && err.message);
    });
  });

  async function handle(req, res) {
    setSecurityHeaders(res);

    // DNS-rebinding guard: reject any non-allowlisted Host before touching the
    // API or static files. Loopback names are always allowed; deployments opt
    // extra hosts in via allowedHosts / MP_ALLOWED_HOSTS.
    if (!hostAllowed(req.headers['host'], allowedHosts)) {
      return sendJson(res, 403, { error: 'host_not_allowed' });
    }

    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // Same-origin only: reject any cross-origin browser request outright.
    if (!originAllowed(req)) {
      return sendJson(res, 403, { error: 'cross_origin_forbidden' });
    }

    // ---- API ----
    if (pathname === '/api/health') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
      return sendJson(res, 200, { ok: true, service: 'mp-startup-map', registry: registry.length, enriched: enriched.length });
    }

    if (pathname === '/api/startups') {
      if (req.method === 'GET') {
        const user = await readUserRecords();
        return sendJson(res, 200, { registry, enriched, user });
      }
      if (req.method === 'POST') return handleCreate(req, res);
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    if (pathname === '/api/startups/check') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
      if (rateLimited(remoteAddressOf(req))) return sendJson(res, 429, { error: 'rate_limited' });
      const user = await readUserRecords();
      const result = duplicateCheck(
        { name: url.searchParams.get('name') || '', website: url.searchParams.get('website') || '', dipp: url.searchParams.get('dipp') || '' },
        { registry, enriched, user }
      );
      return sendJson(res, 200, result);
    }

    if (pathname === '/api/startups/verify') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
      return handleVerify(req, res);
    }

    // ---- static frontend ----
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }

  async function readBody(req, res) {
    const ctype = String(req.headers['content-type'] || '');
    if (!ctype.includes('application/json')) {
      sendJson(res, 415, { error: 'unsupported_media_type', hint: 'Use application/json' });
      return null;
    }
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > MAX_BODY) {
      sendJson(res, 413, { error: 'payload_too_large', limit: MAX_BODY });
      return null;
    }
    return await new Promise((resolve) => {
      let size = 0;
      const chunks = [];
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_BODY) {
          aborted = true;
          sendJson(res, 413, { error: 'payload_too_large', limit: MAX_BODY });
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (aborted) return;
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          sendJson(res, 400, { error: 'invalid_json' });
          resolve(null);
        }
      });
      req.on('error', () => { if (!aborted) resolve(null); });
    });
  }

  async function handleVerify(req, res) {
    if (rateLimited(remoteAddressOf(req))) return sendJson(res, 429, { error: 'rate_limited' });
    const body = await readBody(req, res);
    if (body === null) return; // response already sent
    const v = validateCandidate(body);
    if (!v.valid) return sendJson(res, 400, { valid: false, errors: v.errors, candidate: v.candidate });
    const user = await readUserRecords();
    const dup = duplicateCheck(v.candidate, { registry, enriched, user });
    return sendJson(res, 200, { valid: true, errors: {}, candidate: v.candidate, duplicate: dup.duplicate, matches: dup.matches, checks: dup.checks });
  }

  async function handleCreate(req, res) {
    if (rateLimited(remoteAddressOf(req))) return sendJson(res, 429, { error: 'rate_limited' });

    // Write policy first — never even read the body from an unauthorized remote.
    const policy = writeAllowed({
      remoteAddress: remoteAddressOf(req),
      adminToken,
      providedToken: req.headers['x-admin-token'],
    });
    if (!policy.allowed) {
      return sendJson(res, 403, { error: 'write_forbidden', reason: policy.reason });
    }

    const body = await readBody(req, res);
    if (body === null) return;

    const v = validateCandidate(body);
    if (!v.valid) return sendJson(res, 400, { valid: false, errors: v.errors });

    // Serialize read-check-persist so concurrent writers can't lose updates or
    // both slip the same identity past the duplicate check.
    const result = await withWriteLock(async () => {
      const user = await readUserRecords();
      const dup = duplicateCheck(v.candidate, { registry, enriched, user });
      if (dup.duplicate) {
        return { status: 409, body: { duplicate: true, matches: dup.matches, checks: dup.checks } };
      }
      const record = {
        id: 'u_' + crypto.randomUUID(),
        ...v.candidate,
        source: 'user',
        createdAt: new Date().toISOString(),
      };
      user.push(record);
      await persistUserRecords(user);
      return { status: 201, body: { ok: true, record } };
    });

    return sendJson(res, result.status, result.body);
  }

  async function readUserRecords() {
    try {
      const raw = await fsp.readFile(userFile, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Missing, empty, or corrupt -> recover as [].
      return [];
    }
  }

  // Atomic write: temp file in the same dir + rename.
  async function persistUserRecords(records) {
    await fsp.mkdir(dataDir, { recursive: true });
    const tmp = path.join(dataDir, `.user_startups.${process.pid}.${crypto.randomUUID()}.tmp`);
    const json = JSON.stringify(records, null, 1);
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(json, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, userFile);
  }

  function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch (err) {
      // Malformed percent-encoding (URIError) -> clean 400, never a 500.
      if (err instanceof URIError) return sendJson(res, 400, { error: 'bad_request' });
      throw err;
    }
    if (rel === '/' || rel === '') rel = '/index.html';

    // Resolve within staticDir and guard against path traversal.
    const resolved = path.resolve(staticDir, '.' + rel);
    const base = path.resolve(staticDir);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }

    // Only public app assets are served; everything else (server internals,
    // tests, task files, data/*.json) is 404. The API is the data source.
    if (!STATIC_ALLOW.has(rel)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Not found');
    }

    fs.stat(resolved, (err, stat) => {
      if (err || !stat.isFile()) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.end('Not found');
      }
      const type = STATIC_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      res.statusCode = 200;
      res.setHeader('Content-Type', type);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(resolved).pipe(res);
    });
  }

  // Introspection hook for tests (bounded-growth assertions). Not used by the app.
  server._rate = rate;

  return server;
}

// ------------------------------------------------------------
// Shared response helpers
// ------------------------------------------------------------

function setSecurityHeaders(res) {
  // Allow Leaflet from unpkg CDN + OSM tiles; everything else same-origin.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://unpkg.com",
      "style-src 'self' 'unsafe-inline' https://unpkg.com",
      "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

// Reject cross-origin browser requests. Same-origin requests either omit Origin
// or send one whose host matches the Host header.
function originAllowed(req) {
  const origin = req.headers['origin'];
  if (!origin) return true; // non-CORS (curl, same-origin GET, server-to-server)
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return host === req.headers['host'];
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

module.exports = {
  createAppServer,
  normalizeName,
  normalizeHostname,
  extractHostnames,
  normalizeDipp,
  isLoopback,
  writeAllowed,
  hostAllowed,
  validateCandidate,
  duplicateCheck,
};

// Start a listener only when run directly.
if (require.main === module) {
  const port = Number(process.env.PORT) || 8000;
  const host = process.env.HOST || '127.0.0.1';
  const server = createAppServer();
  server.listen(port, host, () => {
    const mode = process.env.MP_ADMIN_TOKEN ? 'admin-token set' : 'loopback-write (local prototype)';
    console.log(`MP Startup Map server running at http://${host}:${port}  [${mode}]`);
    console.log('Local prototype mode — do NOT expose the write route publicly. See README.');
  });
}
