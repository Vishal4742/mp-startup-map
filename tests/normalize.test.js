'use strict';

/*
 * Unit tests for shared/normalize.js — the rules the browser and the server
 * both rely on for "same name / same district / same website".
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const N = require('../shared/normalize.js');

const REPO_DATA = path.join(__dirname, '..', 'data');

test('normalizeName: suffixes, punctuation, aliases and the M/s prefix', () => {
  assert.strictEqual(N.normalizeName('CULTEXT TECHNOLOGIES PRIVATE LIMITED'), 'cultext');
  assert.strictEqual(N.normalizeName('  Foo  Bar  Pvt. Ltd. '), 'foo bar');
  assert.strictEqual(N.normalizeName('Walkover / MSG91'), 'walkover');
  assert.strictEqual(N.normalizeName('Jambopay Express Pvt Ltd / FidyPay (DIPP24583)'), 'jambopay express');
  assert.strictEqual(N.normalizeName('M/s GAP ENTERPRISES'), 'gap enterprises');
  assert.strictEqual(N.normalizeName(null), '');
});

test('normalizeDipp / normalizeHostname', () => {
  assert.strictEqual(N.normalizeDipp('  dipp 91907 '), 'DIPP91907');
  assert.strictEqual(N.normalizeHostname('https://www.MSG91.com/contact'), 'msg91.com');
  assert.strictEqual(N.normalizeHostname('javascript:alert(1)'), null);
  assert.strictEqual(N.normalizeHostname('not a url'), null);
});

test('extractUrls / extractHostnames: schemes, bare domains, emails ignored', () => {
  assert.deepStrictEqual(N.extractUrls('https://a.example (parent: https://www.b.example)'), ['https://a.example', 'https://www.b.example']);
  assert.deepStrictEqual(N.extractUrls('skylanedrone.com'), ['https://skylanedrone.com']);
  assert.deepStrictEqual(N.extractUrls('HTTPS://Upper.example/x'), ['HTTPS://Upper.example/x']);
  assert.deepStrictEqual(N.extractUrls('contact hello@mail.example for details'), []);
  assert.deepStrictEqual(N.extractUrls('Acme Pvt.Ltd is not a domain'), []);
  assert.deepStrictEqual(N.extractHostnames('twistmobile.in (site unreachable)'), ['twistmobile.in']);
});

test('stripUrlTokens leaves only the annotation', () => {
  assert.strictEqual(N.stripUrlTokens('twistmobile.in (site unreachable)').trim(), '(site unreachable)');
  assert.strictEqual(N.stripUrlTokens('https://dead-simple.io').trim(), '');
});

test('firstEmail / firstPhone', () => {
  assert.strictEqual(N.firstEmail('Sales: sales@x.example; hr@x.example'), 'sales@x.example');
  assert.strictEqual(N.firstPhone('+91 99816 41111, +91 788 010 7001'), '+91 99816 41111');
  assert.strictEqual(N.firstPhone('0731 6914364 (support)'), '0731 6914364');
  assert.strictEqual(N.firstPhone('+1 786 766 7676 (24x7 US support line); India office number not published'), '+1 786 766 7676');
  assert.strictEqual(N.firstPhone('(0731) 4004455'), '(0731) 4004455');
  assert.strictEqual(N.firstPhone('+1 (888) 781-5717; x'), '+1 (888) 781-5717');
  assert.strictEqual(N.firstPhone('Not publicly listed'), null);
});

test('canonicalDistrict: exact, whole-word, longest-first, never substring', () => {
  const districts = ['Indore', 'Bhopal', 'Dhar', 'Agar Malwa'];
  assert.strictEqual(N.canonicalDistrict('indore', districts), 'Indore');
  assert.strictEqual(N.canonicalDistrict('Pithampur, Dhar', districts), 'Dhar');
  assert.strictEqual(N.canonicalDistrict('Indore/Bhopal', districts), 'Indore');
  assert.strictEqual(N.canonicalDistrict('Agar malwa', districts), 'Agar Malwa');
  assert.strictEqual(N.canonicalDistrict('Dharwad', districts), null);
  assert.strictEqual(N.canonicalDistrict('', districts), null);
  assert.strictEqual(N.canonicalDistrict('Indore', null), null);
});

test('every dossier location resolves to a district_coords key', () => {
  const coords = require(path.join(REPO_DATA, 'district_coords.json'));
  const enriched = require(path.join(REPO_DATA, 'enriched.json'));
  const districts = Object.keys(coords);
  const unresolved = enriched
    .map((e) => e.City || e.District || '')
    .filter((loc) => loc && !N.canonicalDistrict(loc, districts));
  assert.deepStrictEqual(unresolved, []);
});
