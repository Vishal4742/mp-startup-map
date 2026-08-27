/*
 * Normalisation rules shared by the browser (app.js) and the Node server
 * (server.js). Both sides must agree on what "the same name", "the same
 * district" and "the same website" mean, so the rules live here exactly once.
 *
 * Plain script in the browser (attaches window.MPNormalize; loaded by
 * index.html before app.js) and a CommonJS module in Node. No dependencies.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MPNormalize = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Company name -> comparison key: lower-case, drop the "M/s" trade prefix,
  // keep only the part before "(" / "/" / "→" aliases, strip corporate suffixes
  // and punctuation. "M/s GAP ENTERPRISES" and "Gap Enterprises Pvt. Ltd." meet.
  function normalizeName(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/^\s*m\/s\.?\s*/, '')
      .split('(')[0].split('/')[0].split('→')[0]
      .replace(/private limited|pvt\.? ?ltd\.?|llp|limited|technologies|technology/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // DPIIT number -> comparison key ("  dipp91907 " -> "DIPP91907").
  function normalizeDipp(s) {
    return String(s == null ? '' : s).trim().toUpperCase().replace(/\s+/g, '');
  }

  // Bare hostname (lower-case, no "www.") of an http/https URL, else null.
  function normalizeHostname(url) {
    const s = String(url == null ? '' : url).trim();
    if (!s) return null;
    let u;
    try {
      u = new URL(s);
    } catch (_) {
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/^www\./, '') || null;
  }

  // URL tokenising:
  //   URL_RE:         http(s) URLs, stopping at whitespace and common punctuation.
  //   EMAIL_TOKEN_RE: blanked out before the bare-domain scan so "hello@x.com"
  //                   never yields "x.com".
  //   BARE_DOMAIN_RE: scheme-less sites the way the dossiers write them
  //                   ("skylanedrone.com", "textify.ai"). Deliberately lower-case
  //                   only with a short TLD so prose like "Pvt.Ltd" is not one.
  const URL_RE = /https?:\/\/[^\s,()<>"']+/gi;
  const EMAIL_TOKEN_RE = /[^\s,;()<]+@[^\s,;()>]+/g;
  const BARE_DOMAIN_RE = /(^|[\s(])((?:[a-z0-9-]+\.)+[a-z]{2,6})(?=$|[\s,;:)/])/g;

  // Every URL in a free-text field, in order; scheme-less domains come back as
  // https:// URLs after the explicit ones. "https://a.com (parent: https://b.com)".
  function extractUrls(text) {
    const str = String(text == null ? '' : text);
    const out = str.match(URL_RE) || [];
    const rest = str.replace(URL_RE, ' ').replace(EMAIL_TOKEN_RE, ' ');
    let m;
    BARE_DOMAIN_RE.lastIndex = 0;
    while ((m = BARE_DOMAIN_RE.exec(rest)) !== null) out.push('https://' + m[2]);
    return out;
  }

  // The free text with every URL, bare domain and email blanked out — what is
  // left is the annotation ("(site unreachable)", "domain is DEAD").
  function stripUrlTokens(text) {
    return String(text == null ? '' : text)
      .replace(URL_RE, ' ')
      .replace(EMAIL_TOKEN_RE, ' ')
      .replace(BARE_DOMAIN_RE, '$1 ');
  }

  function extractHostnames(text) {
    const out = [];
    for (const url of extractUrls(text)) {
      const h = normalizeHostname(url);
      if (h) out.push(h);
    }
    return out;
  }

  // First email address in a free-text field, else null.
  function firstEmail(text) {
    const m = String(text == null ? '' : text).match(/[^\s,;()<]+@[^\s,;()>]+\.[a-z]{2,}/i);
    return m ? m[0] : null;
  }

  // First phone number in a free-text field ("+91 99816 41111, +91 788 010 7001"
  // -> "+91 99816 41111"; "0731 6914364 (support)" -> "0731 6914364"). Parentheses
  // count only around a digit group — "(0731) …", "(+91) …", "+1 (888) …" — so an
  // annotation such as "(24x7 support line)" is never swallowed into the number.
  function firstPhone(text) {
    const m = String(text == null ? '' : text).match(/(?:\+?\d|\(\+?\d+\))(?:[\d\s\-]|\(\d+\)){4,}\d/);
    return m ? m[0].trim() : null;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Does `text` contain `word` as a whole word? ("pithampur, dhar" yes; "dharwad" no.)
  function containsWord(text, word) {
    return new RegExp('(^|[^a-z0-9])' + escapeRegExp(word) + '([^a-z0-9]|$)').test(text);
  }

  // Map free text ("indore", "Pithampur, Dhar", "Indore/Bhopal") onto one of the
  // known district names, or null: exact match first, then the longest district
  // name present as a whole word.
  function canonicalDistrict(text, districts) {
    const t = String(text == null ? '' : text).trim().toLowerCase();
    if (!t || !Array.isArray(districts)) return null;
    const byLength = districts.slice().sort((a, b) => b.length - a.length);
    for (const d of byLength) if (t === d.toLowerCase()) return d;
    for (const d of byLength) if (containsWord(t, d.toLowerCase())) return d;
    return null;
  }

  return {
    normalizeName,
    normalizeDipp,
    normalizeHostname,
    extractUrls,
    extractHostnames,
    stripUrlTokens,
    firstEmail,
    firstPhone,
    escapeRegExp,
    containsWord,
    canonicalDistrict,
  };
});
