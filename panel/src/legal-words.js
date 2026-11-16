'use strict';
// The one list of legal words (P2-227). Every reader uses this file and keeps no copy of its own:
//   wk-job (a legal prompt runs on the newest top model), the Gemini queue (the "legal" lane), the steward (a legal idea waits
//   for the owner), and the panel (a legal question or suggestion needs a second press, and a legal job shows its label).
// CommonJS in panel/src, so the panel and the vendored web page get it next to data.js; the bin/ scripts load it with createRequire.
// The owner's rule (16 Nov 2026): legal wording is always checked by the newest top model, and waits for the owner's approval before use.

// Each entry is a word or a phrase; matching ignores case and allows a plural or verb ending (s, es, d, ed, ing).
const LEGAL_WORDS = Object.freeze([
  'legal', 'legally', 'terms', 'terms of service', 'terms of use', 'terms and conditions', 'privacy', 'privacy policy', 'privacy notice',
  'licence', 'license', 'licensing', 'contract', 'consent', 'gdpr', 'ccpa', 'coppa', 'compliance', 'compliant', 'liability', 'liabilities',
  'disclaimer', 'copyright', 'trademark', 'cookie policy', 'cookie banner', 'data protection', 'refund policy', 'warranty', 'warranties',
  'eula', 'nda', 'non-disclosure', 'indemnity', 'indemnification', 'intellectual property', 'patent', 'acceptable use policy',
  'governing law', 'jurisdiction', 'lawyer', 'attorney',
]);

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s-]+');
// The longest first, so "privacy policy" is reported rather than "privacy".
const SORTED = [...LEGAL_WORDS].sort((a, b) => b.length - a.length);
const RE = new RegExp(`(?<![a-z0-9])(?:${SORTED.map(esc).join('|')})(?:s|es|d|ed|ing)?(?![a-z0-9])`, 'i');
// "in terms of" is plain English, not a legal text
const PLAIN = /\bin terms of\b/gi;

// The legal word a text holds (lower case), or null.
function isLegal(text) {
  const m = RE.exec(String(text == null ? '' : text).replace(PLAIN, ' '));
  return m ? m[0].toLowerCase().replace(/[\s-]+/g, ' ') : null;
}

// What the panel, the W job item and the job's own record say about a legal job.
const legalLabel = id => `Legal: newest top model${id ? ` (${id})` : ''}`;

module.exports = { LEGAL_WORDS, isLegal, legalLabel };
