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

const {
  createAppServer,
  normalizeName,
  normalizeHostname,
  normalizeDipp,
  validateCandidate,
  duplicateCheck,
  isLoopback,
  writeAllowed,
} = require('../server.js');

const REPO_DATA = path.join(__dirname, '..', 'data');

// ---- temp data dir per suite invocation --------------------------------
function makeTempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-map-test-'));
  fs.copyFileSync(path.join(REPO_DATA, 'tech_registry.json'), path.join(dir, 'tech_registry.json'));
  fs.copyFileSync(path.join(REPO_DATA, 'enriched.json'), path.join(dir, 'enriched.json'));
  fs.copyFileSync(path.join(REPO_DATA, 'district_coords.json'), path.join(dir, 'district_coords.json'));
  return dir;
}

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

test('writeAllowed: loopback always, remote needs matching token', () => {
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
