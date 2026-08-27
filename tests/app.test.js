'use strict';

/*
 * Frontend unit tests: app.js is loaded into a vm sandbox with a stub DOM (no
 * browser), together with shared/normalize.js, and its pure functions are
 * exercised against the real data files. Rendering is covered by the frontend
 * contract check (scripts/check-frontend.mjs); this file covers the logic.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const registry = JSON.parse(read('data/tech_registry.json'));
const enriched = JSON.parse(read('data/enriched.json'));
const coords = JSON.parse(read('data/district_coords.json'));

// Minimal DOM: every element lookup returns an inert node, so app.js can boot
// (its data load fails immediately, which the boot code handles) and expose
// its functions for testing.
function loadApp() {
  const stubEl = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    value: '', textContent: '', innerHTML: '', hidden: true, disabled: false,
    options: [], style: {}, dataset: {},
    focus() {}, appendChild() {}, insertBefore() {}, querySelector: () => null, querySelectorAll: () => [],
  });
  const document = {
    getElementById: stubEl, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, body: stubEl(), documentElement: stubEl(), activeElement: null,
    contains: () => false, createElement: stubEl, createDocumentFragment: stubEl,
  };
  const sandbox = {
    document, console: { error() {}, warn() {}, log() {} }, setTimeout, clearTimeout,
    innerWidth: 1200, matchMedia: () => ({ matches: false, addEventListener() {} }),
    location: { hash: '', pathname: '/', search: '' }, history: { replaceState() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }), URLSearchParams, L: {},
  };
  sandbox.window = sandbox; // window === globalThis, as in a browser
  sandbox.self = sandbox;
  const exports = '\n;({ displayName, titleCase, isMissing, websiteUrl, hasContactChannel, telHref, sortRecords, mergeData, userToRecord, districtFromText, assignCoords, ' +
    'setCoords(c) { COORDS = c; DISTRICT_NAMES = Object.keys(c).sort((a, b) => b.length - a.length); } })';
  return vm.runInNewContext(read('shared/normalize.js') + '\n' + read('app.js') + exports, sandbox, { filename: 'app.js' });
}

const app = loadApp();
app.setCoords(coords);

// Objects created inside the vm have that realm's Object.prototype, which
// deepStrictEqual rejects; compare plain copies instead.
const plain = (o) => ({ ...o });
const dn = (name) => plain(app.displayName(name));

test('displayName title-cases all-caps registry names and splits the legal suffix', () => {
  assert.deepStrictEqual(dn('DIGITAL ONE BOX PRIVATE LIMITED'), { main: 'Digital One Box', suffix: 'Private Limited' });
  assert.deepStrictEqual(dn('SHAKAMBRI BIOTECH VENTURE LLP'), { main: 'Shakambri Biotech Venture', suffix: 'LLP' });
  assert.deepStrictEqual(dn('IT SERVICES HUB PVT LTD'), { main: 'IT Services Hub', suffix: 'Pvt Ltd' });
  assert.deepStrictEqual(dn('ABC RESEARCH AND DEVELOPMENT PRIVATE LIMITED').main, 'Abc Research and Development');
  assert.deepStrictEqual(dn('3D PRINTERS OF INDIA (OPC) PRIVATE LIMITED'), { main: '3D Printers of India', suffix: '(OPC) Private Limited' });
  // Mixed-case dossier names are left exactly as written.
  assert.deepStrictEqual(dn('Walkover / MSG91'), { main: 'Walkover / MSG91', suffix: '' });
  assert.deepStrictEqual(dn('Endorphins Healthcare and Research Private Limited'), { main: 'Endorphins Healthcare and Research', suffix: 'Private Limited' });
  assert.deepStrictEqual(dn(''), { main: '', suffix: '' });
});

test('displayName never changes anything but letter case', () => {
  const strip = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [name] of registry) {
    const { main, suffix } = app.displayName(name);
    assert.strictEqual(strip(main + suffix), strip(name), name);
  }
});

test('isMissing recognises every placeholder spelling the dossiers use, and nothing else', () => {
  for (const v of ['Not publicly listed (contact form only)', 'not listed', 'n/a (company defunct)', 'N/A', 'Not applicable', 'Not publicly promoted', 'not publicly found', 'No active website found — none', '-', '', null]) {
    assert.strictEqual(app.isMissing(v), true, String(v));
  }
  for (const v of ['No-code loyalty platform', 'Novel drug discovery', 'NA Technologies', 'Na Li', 'na.com', 'Unknown', 'https://x.example']) {
    assert.strictEqual(app.isMissing(v), false, v);
  }
});

test('websiteUrl links live sites (bare domains included) but never dead ones', () => {
  assert.strictEqual(app.websiteUrl('https://msg91.com (parent: https://walkover.in)'), 'https://msg91.com');
  assert.strictEqual(app.websiteUrl('skylanedrone.com'), 'https://skylanedrone.com');
  assert.strictEqual(app.websiteUrl('https://dead-simple.io'), 'https://dead-simple.io');
  assert.strictEqual(app.websiteUrl('twistmobile.in (site unreachable)'), null);
  assert.strictEqual(app.websiteUrl('admadtech.com listed on LinkedIn but domain is DEAD (NXDOMAIN)'), null);
  assert.strictEqual(app.websiteUrl('Not publicly listed'), null);
});

test('hasContactChannel requires a linkable website, email or phone', () => {
  assert.strictEqual(app.hasContactChannel({ Website: 'Not publicly listed', 'Public contact email': 'Not publicly listed', 'Public phone': 'Not publicly listed' }), false);
  assert.strictEqual(app.hasContactChannel({ Website: 'No active website found', 'Public contact email': 'n/a', 'Public phone': '+91 99816 41111' }), true);
  assert.strictEqual(app.hasContactChannel({ Website: 'x.example.com' }), true);
  assert.strictEqual(app.hasContactChannel(null), false);
  assert.strictEqual(app.telHref('+91 99816 41111'), 'tel:+919981641111');
});

test('mergeData joins dossiers to registry rows and reads District as well as City', () => {
  const records = app.mergeData(registry, enriched, []);
  // One record per registry row, plus one per dossier that matched nothing.
  const standalone = records.filter((r) => r.id.startsWith('s')).length;
  const matched = records.filter((r) => r.id.startsWith('r') && r.enriched).length;
  assert.strictEqual(records.length, registry.length + standalone);
  assert.strictEqual(standalone + matched, enriched.length, 'every dossier lands exactly once');
  // Districts are always a coords key or the single 'Unknown' sentinel, and a
  // blank registry district is filled from the dossier when one is attached.
  for (const r of records) assert.ok(r.district === 'Unknown' || coords[r.district], `${r.name}: ${r.district}`);
  const blank = registry.filter((row) => !row[4]).length;
  assert.ok(records.filter((r) => r.district === 'Unknown').length <= blank);
  const jambo = records.find((r) => /jambopay/i.test(r.name));
  if (jambo) {
    assert.strictEqual(jambo.district, 'Indore', 'dossier District fills a blank registry district');
    app.assignCoords(jambo);
    assert.ok(Math.abs(jambo.lat - coords.Indore[0]) < 0.05 && Math.abs(jambo.lng - coords.Indore[1]) < 0.05);
  }
  for (const r of records) assert.ok(typeof r.searchText === 'string' && r.searchText.includes(r.name.toLowerCase()));
  // hasContacts is decided per dossier by the same rule, so the counts agree.
  assert.strictEqual(records.filter((r) => r.hasContacts).length, enriched.filter((e) => app.hasContactChannel(e)).length);
});

test('userToRecord canonicalises the district and derives hasContacts from channels', () => {
  const rec = app.userToRecord({ id: 'u_1', name: 'X', district: 'indore city', city: 'Pithampur', website: '', email: '', phone: '' }, 0);
  assert.strictEqual(rec.district, 'Indore');
  assert.strictEqual(rec.hasContacts, false);
  assert.strictEqual(rec.isUser, true);
  assert.strictEqual(app.userToRecord({ name: 'Y', district: 'Atlantis' }, 1).district, 'Atlantis', 'legacy raw value kept as a last resort');
  assert.strictEqual(app.userToRecord({ name: 'Z', district: '', city: 'Bhopal' }, 2).district, 'Bhopal');
  assert.strictEqual(app.userToRecord({ name: 'W', district: 'Dhar', email: 'hi@w.example' }, 3).hasContacts, true);
});

test('sortRecords: Unknown last, name A–Z case-insensitive, contacts first', () => {
  const records = app.mergeData(registry, enriched, [{ id: 'u_9', name: 'aaa community', district: 'Dhar', website: 'https://aaa.example' }]);
  const byDistrict = app.sortRecords(records, 'district');
  assert.notStrictEqual(byDistrict[0].district, 'Unknown');
  assert.strictEqual(byDistrict[byDistrict.length - 1].district, 'Unknown');
  const byName = app.sortRecords(records, 'name');
  for (let i = 1; i < byName.length; i++) {
    assert.ok(byName[i - 1].name.localeCompare(byName[i].name, 'en', { sensitivity: 'base' }) <= 0);
  }
  const contactsFirst = app.sortRecords(records, 'contacts');
  const firstWithout = contactsFirst.findIndex((r) => !r.hasContacts);
  assert.ok(contactsFirst.slice(0, firstWithout).every((r) => r.hasContacts));
  assert.ok(contactsFirst.slice(firstWithout).every((r) => !r.hasContacts));
  assert.strictEqual(records.length, byName.length, 'sorting never mutates or drops records');
});

test('districtFromText mirrors the server rule', () => {
  assert.strictEqual(app.districtFromText('Indore/Bhopal'), 'Indore');
  assert.strictEqual(app.districtFromText('MyChild App (Bhopal)'), 'Bhopal');
  assert.strictEqual(app.districtFromText('Dharwad'), null);
  assert.strictEqual(app.districtFromText(''), null);
});
