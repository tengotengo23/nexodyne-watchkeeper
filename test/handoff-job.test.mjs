// wk-job handoff and clear (P2-257): W's clear is real for jobs it runs itself, and only once the continue file is ready.
// A temp HOME and WK_HOME; no runner and no claude are started (spawnRunner is a stub). Run: node --test test/handoff-job.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-hjob-')), WK = path.join(HOME, '.wk');
process.env.HOME = HOME; process.env.WK_HOME = WK; process.env.WK_STEWARD_DIR = path.join(WK, 'steward');
const REPO = path.join(HOME, 'Projects', 'alpha'); fs.mkdirSync(path.join(REPO, '.git'), { recursive: true }); fs.mkdirSync(WK, { recursive: true });
fs.writeFileSync(path.join(WK, 'projects.json'), JSON.stringify({ projects: [{ key: 'alpha', name: 'alpha', path: '~/Projects/alpha', kind: 'repo' }] }));
fs.writeFileSync(path.join(WK, 'remote.json'), JSON.stringify({ orchestration: path.join(HOME, 'orch') }));
const J = await import('../bin/wk-job.mjs'), H = await import('../bin/wk-handoff.mjs');
const started = [], deps = { freeMb: () => 8000, pacePct: () => null, spawnRunner: (id) => { started.push(id); return 999999; } };
const metaFile = (id) => path.join(WK, 'jobs', id, 'meta.json'), meta = (id) => JSON.parse(fs.readFileSync(metaFile(id), 'utf8'));
const setState = (id, state) => { const m = meta(id); m.state = state; m.session_id = 'sess-1'; m.runner_pid = null; m.ended_at = Date.now(); fs.writeFileSync(metaFile(id), JSON.stringify(m)); };
const GOOD = (goal) => `# Continue\n## Goal\n${goal}\n## Done\n- one thing, with evidence\n## State\nnothing held\n## Next\n1. the next step\n## Decisions and rules\nnone\n## Resume prompt\nStart at step 1 and check the state first.\n${'x'.repeat(200)}\n${H.END}\n`;

test('clear refuses without a ready file, while running, and for a job nobody asked; handoff asks the waiting job; clear then starts a fresh job and closes the old one', () => {
  const a = J.start({ project: 'alpha', prompt: 'Fix the footer', model: 'sonnet', mode: 'auto', from: 'phone' }, { deps });
  setState(a.id, 'waiting');
  assert.throws(() => J.clear(a.id, { deps }), /no usable continue file.*W has not asked/);
  const h = J.handoff(a.id, { why: 'the context is large', deps });
  assert.equal(meta(a.id).state, 'queued'); assert.match(fs.readFileSync(path.join(WK, 'jobs', a.id, 'prompt-2.txt'), 'utf8'), new RegExp(h.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  setState(a.id, 'running'); assert.throws(() => J.clear(a.id, { deps }), /can be cleared only while it waits/);
  setState(a.id, 'waiting'); assert.throws(() => J.clear(a.id, { deps }), /does not exist yet/);
  fs.mkdirSync(path.dirname(h.file), { recursive: true }); fs.writeFileSync(h.file, GOOD('ship the footer fix'));
  const n0 = started.length, r = J.clear(a.id, { deps });
  assert.equal(started.length, n0 + 1); assert.notEqual(r.next.id, a.id);
  assert.match(fs.readFileSync(path.join(WK, 'jobs', r.next.id, 'prompt-1.txt'), 'utf8'), /fresh session: job .* was cleared[\s\S]*ship the footer fix/);
  assert.ok(!fs.readFileSync(path.join(WK, 'jobs', r.next.id, 'prompt-1.txt'), 'utf8').includes(H.END));
  const old = meta(a.id); assert.equal(old.state, 'done'); assert.match(old.last_text, new RegExp(`continued in ${r.next.id}`));
  assert.equal(meta(r.next.id).project, 'alpha'); assert.equal(meta(r.next.id).mode, 'auto');
  assert.equal(H.peekForJob(a.id).ok, false, 'the file is used once');
});

test('a file with a key in it is not used; a failed start leaves the file for another try', () => {
  const a = J.start({ project: 'alpha', prompt: 'Another job', model: 'sonnet', mode: 'auto', from: 'phone' }, { deps }); setState(a.id, 'waiting');
  const h = H.askForJob(a.id, 'test'); fs.mkdirSync(path.dirname(h.file), { recursive: true });
  fs.writeFileSync(h.file, GOOD('goal').replace('goal', 'key sk_' + 'live_abcdefghijklmnop1234')); assert.throws(() => J.clear(a.id, { deps }), /key or password/);
  fs.writeFileSync(h.file, GOOD('goal two'));
  assert.throws(() => J.clear(a.id, { deps: { ...deps, freeMb: () => 10 } }), /MB free/);
  assert.equal(meta(a.id).state, 'waiting'); assert.equal(H.peekForJob(a.id).ok, true, 'still ready after the refused start');
  assert.equal(J.clear(a.id, { deps }).old, a.id);
});
