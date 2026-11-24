// P2-272 (B) 5b: the status line's "skills N" part and the approved-only library count.
// Each case runs in a fresh mkdtemp HOME / WK_HOME / vault; the owner's real files are never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wk-handoff.mjs');
const KEYS = ['HOME', 'WK_HOME', 'WK_STEWARD_DIR', 'REPROMPT_DATA_DIR', 'REPROMPT_SKILL_VAULT_DIR'];

async function sandbox(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2b-status-'));
  const old = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  const wk = path.join(home, '.wk');
  const vault = path.join(home, '.gemini', 'skill-vault');
  fs.mkdirSync(wk, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  Object.assign(process.env, { HOME: home, WK_HOME: wk, WK_STEWARD_DIR: path.join(wk, 'steward'),
    REPROMPT_DATA_DIR: path.join(home, 'data'), REPROMPT_SKILL_VAULT_DIR: vault });
  try {
    const H = await import(BIN);
    return await fn({ H, home, wk, vault });
  } finally {
    for (const k of KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  }
}

function injected(wk, data) {
  const d = path.join(wk, 'runtime', 'skills-injected');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'latest.json'), JSON.stringify(data));
}

test('no latest.json: no "skills" part', () => sandbox(({ H }) => {
  assert.ok(!/· skills \d/.test(H.statusLine()), H.statusLine());
}));

test('count 0: no "skills" part; count 2: "· skills 2"', () => sandbox(({ H, wk }) => {
  injected(wk, { count: 0, session: 's1', ids: [] });
  assert.ok(!/skills \d/.test(H.statusLine()));
  injected(wk, { count: 2, session: 's1', ids: ['a', 'b'] });
  assert.match(H.statusLine(), /· skills 2(\s|$)/);
  injected(wk, { count: 'x' });
  assert.ok(!/skills \d/.test(H.statusLine()), 'a bad count shows nothing');
}));

test('librarySummary counts approved and local-installed skills only (staged and rejected left out)', () => sandbox(({ H, vault }) => {
  fs.writeFileSync(path.join(vault, 'sources.json'), JSON.stringify({ version: 2, repos: [
    { slug: 'good', repo: 'o/good', approved: true, status: 'approved' },
    { slug: 'fresh', repo: 'o/fresh', approved: false, status: 'staged' },
    { slug: 'gone', repo: 'o/gone', approved: false, status: 'rejected' },
  ] }));
  fs.writeFileSync(path.join(vault, 'index.json'), JSON.stringify({ skill_count: 5, skills: [
    { id: 'good/a', name: 'a', slug: 'good', repo: 'o/good' },
    { id: 'good/b', name: 'b', slug: 'good', repo: 'o/good' },
    { id: 'local-installed/own', name: 'own', slug: 'local-installed', repo: 'local/claude-skills' },
    { id: 'fresh/c', name: 'c', slug: 'fresh', repo: 'o/fresh' },
    { id: 'gone/d', name: 'd', slug: 'gone', repo: 'o/gone' },
  ] }));
  assert.deepEqual(H.librarySummary(), { skills: 3, toReview: 1 });
}));

test('librarySummary with only skill_count keeps the old behaviour', () => sandbox(({ H, vault }) => {
  fs.writeFileSync(path.join(vault, 'index.json'), JSON.stringify({ skill_count: 22 }));
  fs.writeFileSync(path.join(vault, 'sources.json'), JSON.stringify({ version: 2, repos: [
    { slug: 'good', repo: 'o/good', approved: true, status: 'approved' },
  ] }));
  assert.deepEqual(H.librarySummary(), { skills: 22, toReview: 0 });
}));
