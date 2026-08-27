'use strict';

/*
 * Backend test suite for the MP Startup Map platform.
 * Uses node:test + node:assert only. Never touches the real data/ directory —
 * every test copies the immutable source JSON into a fresh temp dir.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// createAppServer falls back to MP_ADMIN_TOKEN / MP_ALLOWED_HOSTS when an option
// is omitted, so a developer's shell environment must never leak into the suite.
delete process.env.MP_ADMIN_TOKEN;
delete process.env.MP_ALLOWED_HOSTS;
// server.js only silences request-error logging under NODE_ENV=test; set it
// here (in-process) so the npm script stays cross-platform.
process.env.NODE_ENV = 'test';

const {
  createAppServer,
  normalizeName,
  normalizeHostname,
  extractHostnames,
  normalizeDipp,
  canonicalDistrict,
  validateCandidate,
  duplicateCheck,
  isLoopback,
  writeAllowed,
  hostAllowed,
} = require('../server.js');

const REPO_DATA = path.join(__dirname, '..', 'data');

// ---- temp data dir per test (removed when the suite finishes) -----------
const tempDirs = [];
function makeTempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-map-test-'));
  fs.copyFileSync(path.join(REPO_DATA, 'tech_registry.json'), path.join(dir, 'tech_registry.json'));
  fs.copyFileSync(path.join(REPO_DATA, 'enriched.json'), path.join(dir, 'enriched.json'));
  fs.copyFileSync(path.join(REPO_DATA, 'district_coords.json'), path.join(dir, 'district_coords.json'));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---- request helper against an ephemeral listener ----------------------
function withServer(opts, run) {
  return new Promise((resolve, reject) => {
    const server = createAppServer(opts);
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      try {
        const result = await run({ port, server });
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

function request(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: { ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

const baseOpts = (dataDir, extra = {}) => ({
  dataDir,
  rateLimit: { max: 10000, windowMs: 60000 },
  ...extra,
});

// ========================================================================
// Pure helpers
// ========================================================================

test('normalizeName strips corporate suffixes and punctuation', () => {
  assert.strictEqual(normalizeName('CULTEXT TECHNOLOGIES PRIVATE LIMITED'), normalizeName('Cultext'));
  assert.strictEqual(normalizeName('  Foo  Bar  Pvt. Ltd. '), 'foo bar');
});

test('normalizeName treats an "M/s" trade prefix as noise, not as a slash-separated alias', () => {
  // Four registry rows start with "M/s …"; splitting on "/" first collapsed them all to "m".
  assert.strictEqual(normalizeName('M/s GAP ENTERPRISES'), 'gap enterprises');
  assert.strictEqual(normalizeName('M/S IDS WebSoft'), normalizeName('IDS WebSoft'));
  assert.notStrictEqual(normalizeName('M/s GAP ENTERPRISES'), normalizeName('M/s NEXUS ENGINEERING WORKS'));
});

test('extractHostnames accepts bare domains and ignores email addresses', () => {
  // Five dossiers list their site without a scheme (e.g. "skylanedrone.com").
  assert.deepStrictEqual(extractHostnames('skylanedrone.com'), ['skylanedrone.com']);
  assert.deepStrictEqual(extractHostnames('twistmobile.in (site unreachable)'), ['twistmobile.in']);
  assert.deepStrictEqual(
    extractHostnames('https://a.example (parent: https://www.b.example)'),
    ['a.example', 'b.example']
  );
  assert.deepStrictEqual(extractHostnames('contact hello@mail.example for details'), []);
  assert.deepStrictEqual(extractHostnames('Not publicly listed'), []);
});

test('canonicalDistrict maps free text onto a known district (case-insensitive, longest match) or null', () => {
  const districts = ['Indore', 'Bhopal', 'Dhar', 'Agar Malwa'];
  assert.strictEqual(canonicalDistrict('indore', districts), 'Indore');
  assert.strictEqual(canonicalDistrict('Pithampur, Dhar', districts), 'Dhar');
  assert.strictEqual(canonicalDistrict('Agar malwa', districts), 'Agar Malwa');
  assert.strictEqual(canonicalDistrict('Atlantis', districts), null);
  assert.strictEqual(canonicalDistrict('', districts), null);
  // Whole-word only: a district name inside a longer place name is not a match.
  assert.strictEqual(canonicalDistrict('Dharwad', districts), null);
  assert.strictEqual(canonicalDistrict('Dharamshala', districts), null);
  assert.strictEqual(canonicalDistrict('Indore/Bhopal', districts), 'Indore');
});

test('normalizeHostname lowercases, strips www, requires http(s)', () => {
  assert.strictEqual(normalizeHostname('https://www.MSG91.com/contact'), 'msg91.com');
  assert.strictEqual(normalizeHostname('http://Example.COM'), 'example.com');
  assert.strictEqual(normalizeHostname('ftp://example.com'), null);
  assert.strictEqual(normalizeHostname('javascript:alert(1)'), null);
  assert.strictEqual(normalizeHostname('not a url'), null);
});

test('normalizeDipp uppercases and trims', () => {
  assert.strictEqual(normalizeDipp('  dipp91907 '), 'DIPP91907');
  assert.strictEqual(normalizeDipp(''), '');
});

test('isLoopback recognises loopback addresses', () => {
  assert.strictEqual(isLoopback('127.0.0.1'), true);
  assert.strictEqual(isLoopback('::1'), true);
  assert.strictEqual(isLoopback('::ffff:127.0.0.1'), true);
  assert.strictEqual(isLoopback('8.8.8.8'), false);
});

test('writeAllowed: no token configured -> loopback writes, remote refused', () => {
  assert.strictEqual(writeAllowed({ remoteAddress: '127.0.0.1' }).allowed, true);
  assert.strictEqual(writeAllowed({ remoteAddress: '8.8.8.8' }).allowed, false);
  assert.strictEqual(
    writeAllowed({ remoteAddress: '8.8.8.8', adminToken: 'secret', providedToken: 'secret' }).allowed,
    true
  );
  assert.strictEqual(
    writeAllowed({ remoteAddress: '8.8.8.8', adminToken: 'secret', providedToken: 'wrong' }).allowed,
    false
  );
});

test('writeAllowed: a configured token is required for ALL writes, even loopback', () => {
  // Reverse-proxy safety: when a token is configured, a same-host (loopback)
  // caller must still present the matching X-Admin-Token — no loopback bypass.
  assert.strictEqual(writeAllowed({ remoteAddress: '127.0.0.1', adminToken: 'secret' }).allowed, false);
  assert.strictEqual(
    writeAllowed({ remoteAddress: '127.0.0.1', adminToken: 'secret', providedToken: 'secret' }).allowed,
    true
  );
  assert.strictEqual(
    writeAllowed({ remoteAddress: '127.0.0.1', adminToken: 'secret', providedToken: 'wrong' }).allowed,
    false
  );
  // Remote with the right token is still allowed.
  assert.strictEqual(
    writeAllowed({ remoteAddress: '8.8.8.8', adminToken: 'secret', providedToken: 'secret' }).allowed,
    true
  );
});

// ========================================================================
// validateCandidate
// ========================================================================

test('validateCandidate flags missing required fields', () => {
  const r = validateCandidate({});
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.name);
  assert.ok(r.errors.district);
  assert.ok(r.errors.sector);
});

test('validateCandidate rejects unsafe website protocol and bad email/phone', () => {
  const r = validateCandidate({
    name: 'Acme Labs',
    district: 'Indore',
    sector: 'SaaS',
    website: 'javascript:alert(1)',
    email: 'not-an-email',
    phone: 'call-me-maybe!!!',
  });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.website);
  assert.ok(r.errors.email);
  assert.ok(r.errors.phone);
});

test('validateCandidate accepts a clean record and returns normalized candidate', () => {
  const r = validateCandidate({
    name: '  Acme Labs Pvt. Ltd. ',
    district: 'Indore',
    sector: 'SaaS',
    website: 'https://www.acme-labs.example/',
    email: 'hello@acme-labs.example',
    phone: '+91 731 1234567',
    dipp: 'dipp123456',
  });
  assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
  assert.strictEqual(r.candidate.name, 'Acme Labs Pvt. Ltd.');
  assert.strictEqual(r.candidate.dipp, 'DIPP123456');
});

test('validateCandidate enforces field length limits', () => {
  const r = validateCandidate({
    name: 'x'.repeat(500),
    district: 'Indore',
    sector: 'SaaS',
  });
  assert.strictEqual(r.valid, false);
  assert.ok(r.errors.name);
});

test('validateCandidate canonicalises district against the known list and rejects unknown ones', () => {
  const districts = ['Indore', 'Bhopal', 'Dhar'];
  const ok = validateCandidate({ name: 'Acme Labs', district: ' indore ', sector: 'SaaS' }, { districts });
  assert.strictEqual(ok.valid, true, JSON.stringify(ok.errors));
  assert.strictEqual(ok.candidate.district, 'Indore');

  const bad = validateCandidate({ name: 'Acme Labs', district: 'Atlantis', sector: 'SaaS' }, { districts });
  assert.strictEqual(bad.valid, false);
  assert.ok(bad.errors.district);

  // Without a district list the trimmed raw value is kept (pure-helper use).
  const raw = validateCandidate({ name: 'Acme Labs', district: 'Atlantis', sector: 'SaaS' });
  assert.strictEqual(raw.valid, true);
  assert.strictEqual(raw.candidate.district, 'Atlantis');

  // An EMPTY list (district_coords.json missing) fails closed rather than storing raw text.
  const closed = validateCandidate({ name: 'Acme Labs', district: 'Indore', sector: 'SaaS' }, { districts: [] });
  assert.strictEqual(closed.valid, false);
  assert.ok(closed.errors.district);
});

// ========================================================================
// duplicateCheck
// ========================================================================

test('duplicateCheck matches by normalized name / website / dipp', () => {
  const registry = require(path.join(REPO_DATA, 'tech_registry.json'));
  const enriched = require(path.join(REPO_DATA, 'enriched.json'));
  const datasets = { registry, enriched, user: [] };

  const byName = duplicateCheck({ name: 'cultext technologies private limited' }, datasets);
  assert.strictEqual(byName.duplicate, true);
  assert.ok(byName.matches.some((m) => m.on === 'name'));

  const byDipp = duplicateCheck({ dipp: 'dipp91907' }, datasets);
  assert.strictEqual(byDipp.duplicate, true);
  assert.ok(byDipp.matches.some((m) => m.on === 'dipp'));

  const byWeb = duplicateCheck({ website: 'https://msg91.com' }, datasets);
  assert.strictEqual(byWeb.duplicate, true);
  assert.ok(byWeb.matches.some((m) => m.on === 'website'));

  const clean = duplicateCheck({ name: 'Totally Unique Startup ZZZ 2026' }, datasets);
  assert.strictEqual(clean.duplicate, false);
  assert.deepStrictEqual(clean.matches, []);
});

test('duplicateCheck: a DPIIT number typed as the name is not reported as a name match', () => {
  // Dossier Company strings end in "(DIPPnnnnn)"; that suffix must not be indexed as a name.
  const registry = require(path.join(REPO_DATA, 'tech_registry.json'));
  const enriched = require(path.join(REPO_DATA, 'enriched.json'));
  const r = duplicateCheck({ name: 'DIPP24583' }, { registry, enriched, user: [] });
  assert.ok(r.matches.every((m) => m.on !== 'name'), JSON.stringify(r.matches));
  // The same number in the dipp field is still a DPIIT match.
  const byDipp = duplicateCheck({ dipp: 'DIPP24583' }, { registry, enriched, user: [] });
  assert.ok(byDipp.matches.some((m) => m.on === 'dipp'));
});

test('duplicateCheck: a bare-domain dossier website is in the website index', () => {
  const registry = require(path.join(REPO_DATA, 'tech_registry.json'));
  const enriched = require(path.join(REPO_DATA, 'enriched.json'));
  const r = duplicateCheck({ website: 'https://www.skylanedrone.com/' }, { registry, enriched, user: [] });
  assert.ok(r.matches.some((m) => m.on === 'website'), JSON.stringify(r.matches));
});

// ========================================================================
// HTTP endpoints
// ========================================================================

test('createAppServer does not auto-listen', () => {
  const server = createAppServer(baseOpts(makeTempDataDir()));
  assert.strictEqual(server.listening, false);
  server.close();
});

test('GET /api/health returns ok', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'GET', '/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
  });
});

test('GET /api/startups combines registry, enriched and user records', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'GET', '/api/startups');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.registry.length, 656);
    assert.strictEqual(res.json.enriched.length, 80);
    assert.ok(Array.isArray(res.json.user));
    assert.strictEqual(res.json.user.length, 0);
  });
});

test('GET /api/startups includes the district coordinate map (Indore centroid)', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'GET', '/api/startups');
    assert.strictEqual(res.status, 200);
    assert.ok(res.json.coords && typeof res.json.coords === 'object', 'response must include coords map');
    assert.deepStrictEqual(res.json.coords.Indore, [22.7196, 75.8577]);
    // The map is served through the API so data/*.json can stay locked down.
    const staticCoords = await request(port, 'GET', '/data/district_coords.json');
    assert.strictEqual(staticCoords.status, 404, 'district_coords.json must not be a static file');
  });
});

test('GET /api/startups recovers a missing user file as []', async () => {
  const dir = makeTempDataDir();
  assert.strictEqual(fs.existsSync(path.join(dir, 'user_startups.json')), false);
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'GET', '/api/startups');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.user, []);
  });
});

test('GET /api/startups/check reports duplicates and reasons', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const dup = await request(port, 'GET', '/api/startups/check?dipp=dipp91907');
    assert.strictEqual(dup.status, 200);
    assert.strictEqual(dup.json.duplicate, true);
    assert.ok(dup.json.matches.length > 0);

    const clean = await request(port, 'GET', '/api/startups/check?name=Totally%20Unique%20ZZZ%202026');
    assert.strictEqual(clean.json.duplicate, false);
  });
});

test('security headers are present', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'GET', '/api/health');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.ok(res.headers['content-security-policy']);
    assert.ok(res.headers['referrer-policy']);
  });
});

test('POST /api/startups/verify returns field errors for invalid input', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'POST', '/api/startups/verify', {
      headers: { 'content-type': 'application/json' },
      body: { name: '', district: '', sector: '' },
    });
    assert.strictEqual(res.status, 400);
    assert.ok(res.json.errors.name);
    assert.ok(res.json.errors.district);
    assert.ok(res.json.errors.sector);
  });
});

test('POST /api/startups/verify flags duplicates without writing', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'POST', '/api/startups/verify', {
      headers: { 'content-type': 'application/json' },
      body: { name: 'CULTEXT TECHNOLOGIES PRIVATE LIMITED', district: 'Agar Malwa', sector: 'Social Commerce' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.duplicate, true);
    assert.ok(res.json.matches.some((m) => m.on === 'name'));
    assert.strictEqual(fs.existsSync(path.join(dir, 'user_startups.json')), false);
  });
});

test('POST /api/startups persists a valid non-duplicate atomically', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json' },
      body: {
        name: 'Unique Startup ZZZ 2026',
        district: 'Indore',
        sector: 'DeepTech',
        website: 'https://unique-zzz-2026.example',
        email: 'contact@unique-zzz-2026.example',
      },
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.json.record.name, 'Unique Startup ZZZ 2026');
    assert.ok(res.json.record.id);

    const file = path.join(dir, 'user_startups.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].name, 'Unique Startup ZZZ 2026');

    // No leftover temp file from the atomic write.
    const leftover = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepStrictEqual(leftover, []);

    // Appears in the combined feed.
    const feed = await request(port, 'GET', '/api/startups');
    assert.strictEqual(feed.json.user.length, 1);
  });
});

test('POST /api/startups rejects a duplicate and does not write', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json' },
      body: { name: 'CULTEXT TECHNOLOGIES PRIVATE LIMITED', district: 'Agar Malwa', sector: 'Social Commerce' },
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json.duplicate, true);
    assert.strictEqual(fs.existsSync(path.join(dir, 'user_startups.json')), false);
  });
});

test('POST /api/startups stores the canonical district and rejects an unknown one', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const ok = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json' },
      body: { name: 'Canonical District ZZZ 2026', district: ' indore ', city: 'Pithampur', sector: 'SaaS' },
    });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
    assert.strictEqual(ok.json.record.district, 'Indore');
    assert.strictEqual(ok.json.record.city, 'Pithampur');

    const bad = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json' },
      body: { name: 'Nowhere ZZZ 2026', district: 'Atlantis', sector: 'SaaS' },
    });
    assert.strictEqual(bad.status, 400);
    assert.ok(bad.json.errors.district);

    // A non-MP place that merely contains a district name is not silently re-homed.
    const embedded = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json' },
      body: { name: 'Dharwad Startup ZZZ 2026', district: 'Dharwad', sector: 'SaaS' },
    });
    assert.strictEqual(embedded.status, 400);
    assert.ok(embedded.json.errors.district);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'user_startups.json'), 'utf8'));
    assert.strictEqual(saved.length, 1);
  });
});

test('a missing or malformed district_coords.json fails closed (every district rejected, no crash)', async () => {
  for (const content of [null, 'null', '"abc"', '[]', '{}']) {
    const dir = makeTempDataDir();
    const file = path.join(dir, 'district_coords.json');
    if (content === null) fs.unlinkSync(file); else fs.writeFileSync(file, content);
    await withServer(baseOpts(dir), async ({ port }) => {
      const feed = await request(port, 'GET', '/api/startups');
      assert.strictEqual(feed.status, 200);
      assert.deepStrictEqual(feed.json.coords, {}, `coords must normalise to {} for ${JSON.stringify(content)}`);
      const res = await request(port, 'POST', '/api/startups/verify', {
        headers: { 'content-type': 'application/json' },
        body: { name: 'Closed ZZZ 2026', district: 'Indore', sector: 'SaaS' },
      });
      assert.strictEqual(res.status, 400, `district must be rejected for ${JSON.stringify(content)}`);
      assert.ok(res.json.errors.district);
    });
  }
});

test('validation and duplicate failures carry an error code like every other failure', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const verifyBad = await request(port, 'POST', '/api/startups/verify', {
      headers: { 'content-type': 'application/json' },
      body: { name: '' },
    });
    assert.strictEqual(verifyBad.status, 400);
    assert.strictEqual(verifyBad.json.error, 'validation_failed');

    const createBad = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json' },
      body: { name: '' },
    });
    assert.strictEqual(createBad.status, 400);
    assert.strictEqual(createBad.json.error, 'validation_failed');

    const dup = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json' },
      body: { name: 'CULTEXT TECHNOLOGIES PRIVATE LIMITED', district: 'Agar Malwa', sector: 'Social Commerce' },
    });
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(dup.json.error, 'duplicate');
  });
});

test('POST /api/startups rejects a body over 64 KiB', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const huge = JSON.stringify({ name: 'x'.repeat(70 * 1024), district: 'Indore', sector: 'SaaS' });
    const res = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    assert.strictEqual(res.status, 413);
    assert.strictEqual(fs.existsSync(path.join(dir, 'user_startups.json')), false);
  });
});

test('POST /api/startups rejects wrong content-type and wrong method', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const badType = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'text/plain' },
      body: 'name=foo',
    });
    assert.strictEqual(badType.status, 415);

    const badMethod = await request(port, 'DELETE', '/api/startups');
    assert.strictEqual(badMethod.status, 405);
  });
});

test('non-loopback write is denied without a token and allowed with the right token', async () => {
  const dir = makeTempDataDir();
  const body = { name: 'Remote Startup ZZZ 2026', district: 'Bhopal', sector: 'FinTech' };

  // No token configured -> remote denied.
  await withServer(baseOpts(dir, { testRemoteHeader: 'x-test-remote' }), async ({ port }) => {
    const res = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json', 'x-test-remote': '8.8.8.8' },
      body,
    });
    assert.strictEqual(res.status, 403);
  });
  assert.strictEqual(fs.existsSync(path.join(dir, 'user_startups.json')), false);

  // Token configured + provided -> allowed.
  await withServer(baseOpts(dir, { testRemoteHeader: 'x-test-remote', adminToken: 's3cret' }), async ({ port }) => {
    const ok = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json', 'x-test-remote': '8.8.8.8', 'x-admin-token': 's3cret' },
      body,
    });
    assert.strictEqual(ok.status, 201);

    const denied = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json', 'x-test-remote': '8.8.8.8', 'x-admin-token': 'nope' },
      body: { ...body, name: 'Another Remote ZZZ' },
    });
    assert.strictEqual(denied.status, 403);
  });
});

test('CORS: cross-origin request is rejected', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'POST', '/api/startups/verify', {
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: { name: 'Acme', district: 'Indore', sector: 'SaaS' },
    });
    assert.strictEqual(res.status, 403);
  });
});

test('CORS: a same-origin Origin is accepted regardless of Host header casing', async () => {
  // Origin and Host must go through the same hostname normalisation.
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'GET', '/api/health', {
      headers: { host: 'LOCALHOST:' + port, origin: 'http://localhost:' + port },
    });
    assert.strictEqual(res.status, 200);
  });
});

test('explicit adminToken / allowedHosts options override the environment, even when empty', async () => {
  const dir = makeTempDataDir();
  process.env.MP_ADMIN_TOKEN = 'env-secret';
  process.env.MP_ALLOWED_HOSTS = 'env.example';
  try {
    await withServer(baseOpts(dir, { adminToken: '', allowedHosts: [] }), async ({ port }) => {
      const res = await request(port, 'POST', '/api/startups', {
        headers: { 'content-type': 'application/json' },
        body: { name: 'Env Override ZZZ 2026', district: 'Indore', sector: 'SaaS' },
      });
      assert.strictEqual(res.status, 201, 'option adminToken: "" must disable the env token');
      const envHost = await request(port, 'GET', '/api/health', { headers: { host: 'env.example' } });
      assert.strictEqual(envHost.status, 403, 'option allowedHosts: [] must ignore MP_ALLOWED_HOSTS');
    });
    // Both options accept the same shapes: a string (comma-separated for hosts)
    // overrides too, and null means "use the environment" for either.
    await withServer(baseOpts(dir, { adminToken: null, allowedHosts: 'other.example' }), async ({ port }) => {
      const other = await request(port, 'GET', '/api/health', { headers: { host: 'other.example' } });
      assert.strictEqual(other.status, 200, 'a string allowedHosts option must be accepted');
      const envHost = await request(port, 'GET', '/api/health', { headers: { host: 'env.example' } });
      assert.strictEqual(envHost.status, 403, 'a string allowedHosts option must replace MP_ALLOWED_HOSTS');
      const denied = await request(port, 'POST', '/api/startups', {
        headers: { 'content-type': 'application/json' },
        body: { name: 'Env Token ZZZ 2026', district: 'Indore', sector: 'SaaS' },
      });
      assert.strictEqual(denied.status, 403, 'adminToken: null must fall back to MP_ADMIN_TOKEN');
      assert.strictEqual(denied.json.reason, 'bad-token');
    });
    assert.doesNotThrow(() => createAppServer(baseOpts(dir, { allowedHosts: '' })).close());
    // Non-string/array shapes are programming errors, never coerced into a live secret or host.
    assert.throws(() => createAppServer(baseOpts(dir, { adminToken: false })), TypeError);
    assert.throws(() => createAppServer(baseOpts(dir, { adminToken: 0 })), TypeError);
    assert.throws(() => createAppServer(baseOpts(dir, { allowedHosts: false })), TypeError);
    assert.throws(() => createAppServer(baseOpts(dir, { allowedHosts: { host: 'x' } })), TypeError);
  } finally {
    delete process.env.MP_ADMIN_TOKEN;
    delete process.env.MP_ALLOWED_HOSTS;
  }
});

// ========================================================================
// Host allowlist / DNS-rebinding guard
// ========================================================================

test('hostAllowed accepts loopback names (with/without port) and rejects others', () => {
  const allow = ['localhost', '127.0.0.1', '::1'];
  assert.strictEqual(hostAllowed('127.0.0.1:8000', allow), true);
  assert.strictEqual(hostAllowed('localhost:8000', allow), true);
  assert.strictEqual(hostAllowed('localhost', allow), true);
  assert.strictEqual(hostAllowed('[::1]:8000', allow), true);
  assert.strictEqual(hostAllowed('LOCALHOST:8000', allow), true);
  assert.strictEqual(hostAllowed('evil.example', allow), false);
  assert.strictEqual(hostAllowed('127.0.0.1.evil.example', allow), false);
  assert.strictEqual(hostAllowed('', allow), false);
  assert.strictEqual(hostAllowed(undefined, allow), false);
});

test('rejects a non-allowlisted Host header before handling (DNS-rebinding guard)', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'GET', '/api/health', { headers: { host: 'evil.example' } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.error, 'host_not_allowed');
  });
});

test('rejects an evil Host even with a matching evil Origin', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'GET', '/api/health', {
      headers: { host: 'evil.example', origin: 'http://evil.example' },
    });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.error, 'host_not_allowed');
  });
});

test('allows an allowlisted localhost Host', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const res = await request(port, 'GET', '/api/health', { headers: { host: 'localhost:' + port } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
  });
});

test('default 127.0.0.1:ephemeral-port Host keeps working', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    // request() sends Host: 127.0.0.1:<port> by default.
    const res = await request(port, 'GET', '/api/health');
    assert.strictEqual(res.status, 200);
  });
});

test('allowedHosts option adds an intentional deployment host (MP_ALLOWED_HOSTS)', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir, { allowedHosts: ['startups.mp.example'] }), async ({ port }) => {
    const ok = await request(port, 'GET', '/api/health', { headers: { host: 'startups.mp.example' } });
    assert.strictEqual(ok.status, 200);
    // Loopback still allowed alongside the extra host.
    const loop = await request(port, 'GET', '/api/health', { headers: { host: 'localhost' } });
    assert.strictEqual(loop.status, 200);
    // Anything else still rejected.
    const evil = await request(port, 'GET', '/api/health', { headers: { host: 'evil.example' } });
    assert.strictEqual(evil.status, 403);
  });
});

// ========================================================================
// Static-file lockdown
// ========================================================================

test('static serving is limited to public app assets', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const idx = await request(port, 'GET', '/');
    assert.strictEqual(idx.status, 200);
    const indexHtml = await request(port, 'GET', '/index.html');
    assert.strictEqual(indexHtml.status, 200);
    const appJs = await request(port, 'GET', '/app.js');
    assert.strictEqual(appJs.status, 200);
    const cssRes = await request(port, 'GET', '/style.css');
    assert.strictEqual(cssRes.status, 200);
    const shared = await request(port, 'GET', '/shared/normalize.js');
    assert.strictEqual(shared.status, 200);
    assert.ok(shared.headers['content-type'].startsWith('text/javascript'));
    assert.ok(shared.raw.includes('MPNormalize'), 'shared module must attach window.MPNormalize for the browser');
  });
});

test('server internals, tests, docs, config and data are not served (JSON 404)', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    for (const p of [
      '/server.js',
      '/package.json',
      '/tests/server.test.js',
      '/data/tech_registry.json',
      '/data/enriched.json',
      '/data/district_coords.py',
      '/shared/',
      '/shared/normalize.js.map',
      '/README.md',
      '/CLAUDE.md',
      '/.gitignore',
      '/.git/config',
      '/scripts/check-frontend.mjs',
    ]) {
      const r = await request(port, 'GET', p);
      assert.strictEqual(r.status, 404, p + ' should be 404, got ' + r.status);
      assert.strictEqual(r.json && r.json.error, 'not_found', p + ' 404 must be the JSON error envelope');
    }
  });
});

test('path traversal stays 403/404', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const enc = await request(port, 'GET', '/..%2f..%2fserver.js');
    assert.ok(enc.status === 403 || enc.status === 404, 'encoded traversal got ' + enc.status);
    const dotdot = await request(port, 'GET', '/../../package.json');
    assert.ok(dotdot.status === 403 || dotdot.status === 404, 'dotdot got ' + dotdot.status);
  });
});

// ========================================================================
// Malformed request paths
// ========================================================================

test('malformed percent-encoding in the path returns a clean 400', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const r = await request(port, 'GET', '/%E0%A4%A');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'bad_request');
  });
});

// ========================================================================
// Serialized writes (no lost update)
// ========================================================================

test('concurrent unique POSTs both persist (no lost update)', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const mk = (n) => request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json' },
      body: {
        name: 'Concurrent Unique ' + n + ' ZZZ 2026',
        district: 'Indore',
        sector: 'SaaS',
        website: 'https://concurrent-' + n + '-zzz-2026.example',
      },
    });
    const [a, b] = await Promise.all([mk('A'), mk('B')]);
    assert.strictEqual(a.status, 201);
    assert.strictEqual(b.status, 201);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'user_startups.json'), 'utf8'));
    assert.strictEqual(saved.length, 2, 'both unique records must persist');
  });
});

test('concurrent same-identity POSTs: exactly one 201, the other 409', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir), async ({ port }) => {
    const body = {
      name: 'Race Identity ZZZ 2026',
      district: 'Bhopal',
      sector: 'FinTech',
      website: 'https://race-identity-zzz-2026.example',
    };
    const mk = () => request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json' },
      body,
    });
    const results = await Promise.all([mk(), mk()]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepStrictEqual(statuses, [201, 409]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'user_startups.json'), 'utf8'));
    assert.strictEqual(saved.length, 1, 'only one identical record may persist');
  });
});

// ========================================================================
// Rate limiting (429 + bounded map)
// ========================================================================

test('rate limiting returns 429 past the limit and recovers after the window', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir, { rateLimit: { max: 1, windowMs: 150 } }), async ({ port }) => {
    const ok = await request(port, 'GET', '/api/startups/check?name=foo');
    assert.strictEqual(ok.status, 200);
    const limited = await request(port, 'GET', '/api/startups/check?name=foo');
    assert.strictEqual(limited.status, 429);
    await new Promise((r) => setTimeout(r, 220));
    const recovered = await request(port, 'GET', '/api/startups/check?name=foo');
    assert.strictEqual(recovered.status, 200);
  });
});

test('GET /api/startups is rate limited (429) past the limit and recovers after the window', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir, { rateLimit: { max: 1, windowMs: 150 } }), async ({ port }) => {
    const ok = await request(port, 'GET', '/api/startups');
    assert.strictEqual(ok.status, 200);
    const limited = await request(port, 'GET', '/api/startups');
    assert.strictEqual(limited.status, 429);
    assert.strictEqual(limited.json.error, 'rate_limited');
    await new Promise((r) => setTimeout(r, 220));
    const recovered = await request(port, 'GET', '/api/startups');
    assert.strictEqual(recovered.status, 200);
    assert.strictEqual(recovered.json.registry.length, 656);
  });
});

test('rate-limit map prunes expired entries and stays bounded', async () => {
  const dir = makeTempDataDir();
  await withServer(
    baseOpts(dir, { rateLimit: { max: 100, windowMs: 20, pruneAfter: 5 }, testRemoteHeader: 'x-test-remote' }),
    async ({ port, server }) => {
      // First wave of many distinct IPs — creates many entries.
      for (let i = 0; i < 20; i++) {
        await request(port, 'GET', '/api/startups/check?name=foo', { headers: { 'x-test-remote': '10.0.0.' + i } });
      }
      // Let the first wave expire past the tiny window.
      await new Promise((r) => setTimeout(r, 60));
      // Second wave — each new slot past the prune threshold sweeps expired entries.
      for (let i = 0; i < 10; i++) {
        await request(port, 'GET', '/api/startups/check?name=foo', { headers: { 'x-test-remote': '10.1.0.' + i } });
      }
      assert.ok(server._rate, 'rate map should be exposed for introspection');
      assert.ok(
        server._rate.size <= 15,
        'rate map should be pruned (size=' + server._rate.size + ', would be 30 unpruned)'
      );
    }
  );
});

// ========================================================================
// Token policy / reverse-proxy safety
// ========================================================================

test('with an admin token configured, even a loopback write requires the token', async () => {
  const dir = makeTempDataDir();
  const body = {
    name: 'Token Gated ZZZ 2026',
    district: 'Indore',
    sector: 'SaaS',
    website: 'https://token-gated-zzz-2026.example',
  };
  await withServer(baseOpts(dir, { adminToken: 's3cret' }), async ({ port }) => {
    // Loopback, no token -> refused (a same-host reverse proxy can't bypass auth).
    const denied = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.strictEqual(denied.status, 403);
    assert.strictEqual(denied.json.reason, 'bad-token');
    assert.strictEqual(fs.existsSync(path.join(dir, 'user_startups.json')), false);

    // Loopback, matching token -> allowed.
    const ok = await request(port, 'POST', '/api/startups', {
      headers: { 'content-type': 'application/json', 'x-admin-token': 's3cret' },
      body,
    });
    assert.strictEqual(ok.status, 201);
  });
});

test('verify does not require the admin token even when one is configured', async () => {
  const dir = makeTempDataDir();
  await withServer(baseOpts(dir, { adminToken: 's3cret' }), async ({ port }) => {
    const res = await request(port, 'POST', '/api/startups/verify', {
      headers: { 'content-type': 'application/json' },
      body: { name: 'Some Unique ZZZ 2026', district: 'Indore', sector: 'SaaS' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.valid, true);
    assert.strictEqual(res.json.duplicate, false);
  });
});
