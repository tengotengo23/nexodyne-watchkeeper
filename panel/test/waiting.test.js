'use strict';
// P2-223: "Waiting for you" (questions through nx, suggestions through wk-suggest) and Gemini (tasks, sessions, config).
// Every fixture lives in a temp folder; the real orchestration folder, ~/.wk and the plugin's real scripts are never run or touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../src/data');
const R = require('../src/render');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-wait-')));
const write = (p, s, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, mode ? { mode } : undefined); return p; };
const NOW = Date.parse('2026-11-14T12:00:00Z');

const QUESTIONS = `# Questions for the user

Your tooling adds a line here.

- [x] Q100 (2026-11-10 09:00, tab ?): An old one, already ticked. Recommended: yes.
- [ ] Q104 (2026-11-13 10:00, tab ?): T-210 Should the W panel show the pace bar first? Recommended: yes, at the top.
- [ ] Q105 (2026-11-13 11:00, tab site): Which colour for the new badge? There is no recommendation on this one.
- [ ] Q106 (2026-11-14 11:33, tab ?): T-215 Example shop (accounts/direction): switch on the +20 GEL add-on? Recommended: switch on when one customer agrees in writing.
`;

// A fake nx: records its argv (NUL-separated) and its working folder, and ticks the line as the real one does.
const FAKE_NX = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const d = __dirname, a = process.argv.slice(2);
fs.writeFileSync(path.join(d, 'argv.bin'), a.map(x => x + '\\0').join(''));
fs.writeFileSync(path.join(d, 'cwd.txt'), process.cwd());
const q = path.join(d, 'QUESTIONS.md'), lines = fs.readFileSync(q, 'utf8').split('\\n');
const i = lines.findIndex(l => l.startsWith('- [ ] Q' + a[1] + ' '));
if (a[0] !== 'answer' || i < 0) { console.log('no open Q' + a[1]); process.exit(1); }
lines[i] = lines[i].replace('- [ ] ', '- [x] ');
fs.writeFileSync(q, lines.join('\\n'));
console.log('RECORDED in DECISIONS.md');
`;
function orchFixture(text = QUESTIONS) {
  const base = tmp(), orch = path.join(base, 'orchestration');
  write(path.join(orch, 'QUESTIONS.md'), text);
  write(path.join(orch, 'nx'), FAKE_NX, 0o755);
  return { base, orch, argv: () => { const f = path.join(orch, 'argv.bin'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\0').slice(0, -1) : null; } };
}

// Fake plugin scripts (Desk A's interface): each call is recorded with its argv, WK_HOME and folder.
const FAKE_SCRIPT = `import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const f = fileURLToPath(import.meta.url), d = path.dirname(f);
fs.appendFileSync(path.join(d, 'calls.jsonl'), JSON.stringify({ script: path.basename(f), argv: process.argv.slice(2), wk: process.env.WK_HOME, cwd: process.cwd(), env: Object.keys(process.env).sort() }) + '\\n');
if (fs.existsSync(path.join(d, 'FAIL'))) { process.stderr.write('The repository has uncommitted changes to a touched file.\\nsecond line\\n'); process.exit(2); }
console.log(process.argv[2] === 'add' ? '20261114-120000-new-task' : 'Recorded.');
`;
function pluginFixture({ config = true } = {}) {
  const dir = tmp();
  write(path.join(dir, 'bin', 'wk-ledger.mjs'), 'process.exit(3);');
  write(path.join(dir, 'bin', 'wk-suggest.mjs'), FAKE_SCRIPT);
  write(path.join(dir, 'bin', 'wk-task.mjs'), FAKE_SCRIPT);
  if (config) write(path.join(dir, 'config', 'gemini.json'), JSON.stringify({
    automation_prompt: 'Every hour: if ~/.wk/KILL exists, stop. Otherwise use the wk-take-task skill to take the next Watchkeeper task, do it, and finish with done. If nothing is queued, stop.',
    routes: { code: { model: 'gemini-4-hydrogen-xhigh', fallback: 'gemini-4-hydrogen-high', for: 'everyday coding' }, read: { model: 'gemini-3.8-flash-medium', fallback: 'gemini-3.8-flash-low', for: 'read only' }, evil: { model: 'x' } } }));
  const calls = () => { const f = path.join(dir, 'bin', 'calls.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []; };
  return { dir, calls };
}

// ---------------------------------------------------------------- questions
test('questions: open ones only, newest number first, recommendation, money, from and date', () => {
  const { orch } = orchFixture();
  const r = D.readQuestions(orch, NOW);
  assert.equal(r.available, true);
  assert.deepEqual(r.items.map(q => q.n), ['106', '105', '104'], 'the ticked Q100 is left out');
  const [q106, q105, q104] = r.items;
  assert.equal(q104.rec, 'yes, at the top.');
  assert.equal(q104.text, 'T-210 Should the W panel show the pace bar first?');
  assert.equal(q105.rec, '', 'no "Recommended:" means no recommendation');
  assert.deepEqual([q106.money, q105.money, q104.money], [true, false, false], 'GEL and accounts need the second press; colour does not');
  assert.deepEqual([q106.from, q105.from, q104.from], ['T-215', 'site', 'T-210']);
  assert.equal(q106.date, '14 Nov');
  for (const w of ['buy a domain', 'pay the invoice', 'the price', 'US$15', '€199', 'a subscription', 'legal wording', 'the contract', 'the terms', 'the licence', 'a password', 'sign in', 'Stripe'])
    assert.equal(D.isMoney(w), true, w);
  for (const w of ['colour', 'paint the page', 'a pricey-looking font'.replace('pricey', 'fancy'), 'the termsheet'.replace('termsheet', 'timetable')]) assert.equal(D.isMoney(w), false, w);
});

test('questions: need QUESTIONS.md and an executable nx in an absolute folder', () => {
  const { orch } = orchFixture();
  assert.equal(D.questionsAvailable(orch), true);
  fs.chmodSync(path.join(orch, 'nx'), 0o644);
  assert.equal(D.questionsAvailable(orch), false, 'nx not executable');
  fs.chmodSync(path.join(orch, 'nx'), 0o755);
  fs.rmSync(path.join(orch, 'QUESTIONS.md'));
  assert.equal(D.questionsAvailable(orch), false, 'no QUESTIONS.md');
  assert.equal(D.questionsAvailable('orchestration'), false, 'never a relative folder');
  assert.equal(D.questionsAvailable(''), false);
  assert.deepEqual(D.readQuestions('', NOW), { available: false, items: [], total: 0, hidden: 0 });
});

test('questions: Later hides one for 24 hours in panel-state.json (mode 600)', () => {
  const { orch } = orchFixture(), data = path.join(tmp(), 'wk');
  const until = D.setLater(data, '105', NOW);
  assert.equal(until, NOW + 24 * 3600e3);
  assert.equal(fs.statSync(D.panelStateFile(data)).mode & 0o777, 0o600);
  const later = D.readPanelState(data).later;
  assert.deepEqual(later, { Q105: NOW + 24 * 3600e3 });
  const hidden = D.readQuestions(orch, NOW + 3600e3, later);
  assert.deepEqual([hidden.items.map(q => q.n), hidden.hidden], [['106', '104'], 1]);
  assert.deepEqual(D.readQuestions(orch, NOW + 25 * 3600e3, later).items.map(q => q.n), ['106', '105', '104'], 'back after 24 hours');
  assert.throws(() => D.setLater(data, '../x', NOW));
  write(D.panelStateFile(data), JSON.stringify({ later: { Q1: 'soon', 'Q2; rm': 5, Q3: 7 } }));
  assert.deepEqual(D.readPanelState(data).later, { Q3: 7 }, 'only checked keys and numbers are kept');
});

test('nx: the exact argv, run from the orchestration folder\'s parent, never through a shell', async () => {
  const { base, orch, argv } = orchFixture();
  const r = await D.answerQuestion(orch, '104', D.okAnswer('yes, at the top.'));
  assert.equal(r.ok, true, r.err);
  assert.equal(r.out, 'RECORDED in DECISIONS.md');
  assert.deepEqual(argv(), ['answer', '104', 'OK: yes, at the top.']);
  assert.equal(fs.readFileSync(path.join(orch, 'cwd.txt'), 'utf8'), base);
  assert.equal(D.findOpenQuestion(orch, '104'), null, 'the fake ticked it; a second answer finds it closed');
  // hostile text: newlines fold to spaces, control characters go, shell syntax arrives as plain words
  const evil = 'first line\nsecond $(touch PWNED) `touch PWNED2` ; rm -rf ~ | cat\u0007\u001b[31m‮end';
  const r2 = await D.answerQuestion(orch, '105', evil);
  assert.equal(r2.ok, true, r2.err);
  assert.deepEqual(argv(), ['answer', '105', 'first line second $(touch PWNED) `touch PWNED2` ; rm -rf ~ | cat[31mend']);
  assert.equal(fs.existsSync(path.join(base, 'PWNED')) || fs.existsSync(path.join(base, 'PWNED2')), false, 'nothing ran');
  // refused before anything runs
  fs.rmSync(path.join(orch, 'argv.bin'));
  for (const [n, t] of [['abc', 'x'], ['0', 'x'], ['0106', 'x'], ['1234567', 'x'], ['106; ls', 'x'], ['106', ''], ['106', '\n\u0007 '], ['106', 'x'.repeat(4001)]]) {
    const no = await D.answerQuestion(orch, n, t);
    assert.equal(no.ok, false, `${n} ${t.slice(0, 10)}`);
  }
  assert.equal(argv(), null, 'nx never ran for a bad number or text');
  assert.equal(D.okAnswer('x'.repeat(500)).length, 'OK: '.length + 300, 'OK sends up to 300 characters of the recommendation');
});

// ---------------------------------------------------------------- messages
test('the new webview messages are validated against closed sets and patterns', () => {
  const ok = m => D.validateMessage(m);
  assert.deepEqual(ok({ cmd: 'answerQuestion', n: '106', useRecommended: true, text: 'ignored', extra: 1 }), { ok: true, msg: { cmd: 'answerQuestion', n: '106', useRecommended: true, confirmed: false } });
  assert.deepEqual(ok({ cmd: 'answerQuestion', n: 106, text: ' two\nlines\u0000 ', confirmed: true }), { ok: true, msg: { cmd: 'answerQuestion', n: '106', useRecommended: false, text: 'two lines', confirmed: true } });
  for (const n of ['', '0', '01', '1234567', '1.5', '-1', '1e3', '106 ', '../1', null, 1.5, -3, [106]]) assert.equal(ok({ cmd: 'answerQuestion', n, text: 'x' }).ok, false, String(n));
  assert.equal(ok({ cmd: 'answerQuestion', n: '1', text: '   ' }).ok, false);
  assert.equal(ok({ cmd: 'answerQuestion', n: '1', text: 'x'.repeat(4001) }).ok, false);
  assert.equal(ok({ cmd: 'answerQuestion', n: '1' }).ok, false, 'no text and no useRecommended');
  assert.equal(ok({ cmd: 'answerQuestion', n: '1', useRecommended: 'yes' }).ok, false, 'useRecommended must be true itself');
  assert.deepEqual(ok({ cmd: 'laterQuestion', n: '7', path: '/etc' }), { ok: true, msg: { cmd: 'laterQuestion', n: '7' } });
  assert.equal(ok({ cmd: 'laterQuestion', n: 'Q7' }).ok, false);
  const sid = 'S-20261114-101500-a3f9';
  assert.deepEqual(ok({ cmd: 'decideSuggestion', id: sid, choice: 'later' }), { ok: true, msg: { cmd: 'decideSuggestion', id: sid, choice: 'later', confirmed: false } });
  for (const [id, choice] of [[sid, 'merge'], [sid, 'OK'], ['S-20261114-101500-A3F9', 'ok'], ['S-2026111-101500-a3f9', 'ok'], ['../S-20261114-101500-a3f9', 'ok'], [sid + ' ', 'ok']])
    assert.equal(ok({ cmd: 'decideSuggestion', id, choice }).ok, false, `${id} ${choice}`);
  assert.equal(ok({ cmd: 'decideSuggestion', id: sid, choice: 'ok', text: 5 }).ok, false);
  assert.deepEqual(ok({ cmd: 'openTaskDiff', id: '20261114-101500-fix-the-timer', which: '/etc/passwd' }), { ok: true, msg: { cmd: 'openTaskDiff', id: '20261114-101500-fix-the-timer' } });
  for (const id of ['../../etc', '20261114-101500-Fix', '20261114-101500-a/b', '20261114-101500-' + 'a'.repeat(41)]) assert.equal(ok({ cmd: 'openTaskDiff', id }).ok, false, id);
  assert.deepEqual(ok({ cmd: 'addTask', title: ' Fix\nthe timer ', text: 'Line one\nLine two\u0007', kind: 'code' }), { ok: true, msg: { cmd: 'addTask', title: 'Fix the timer', text: 'Line one\nLine two', kind: 'code' } });
  assert.deepEqual(ok({ cmd: 'addTask', title: 'T', kind: '' }), { ok: true, msg: { cmd: 'addTask', title: 'T', text: '', kind: 'auto' } });
  for (const m of [{ title: '', kind: 'code' }, { title: 'x'.repeat(201) }, { title: 'T', text: 'x'.repeat(4001) }, { title: 'T', kind: 'shell' }, { title: 5 }, { title: 'T', text: {} }])
    assert.equal(ok({ cmd: 'addTask', ...m }).ok, false, JSON.stringify(m).slice(0, 40));
  assert.deepEqual(ok({ cmd: 'copyAutomation', text: 'rm -rf' }), { ok: true, msg: { cmd: 'copyAutomation' } });
  assert.equal(ok({ cmd: 'runCommand', argv: ['ls'] }).ok, false, 'no other command');
});

// ---------------------------------------------------------------- suggestions
test('suggestions: open ones newest first; the newest event wins; Later hides 24 hours; bad lines skipped', () => {
  const data = tmp(), at = h => new Date(NOW - h * 3600e3).toISOString();
  write(path.join(data, 'tasks', '20261114-100000-fix-timer', 'change.diff'), 'diff --git a/x b/x\n');
  const lines = [
    { id: 'S-20261114-090000-aaaa', at: at(3), from: 'claude', title: 'Turn on the weekly report', detail: 'Line one\nLine two', action: { type: 'none' } },
    { id: 'S-20261114-100000-bbbb', at: at(2), from: 'watchkeeper', title: 'Gemini finished "Fix the timer", tests pass, merge it?', detail: '', action: { type: 'task-merge', ref: '20261114-100000-fix-timer' } },
    { id: 'S-20261114-110000-cccc', at: at(1), from: 'gemini', title: 'Raise the price to US$20?', detail: 'x', action: { type: 'none' } },
    { id: 'S-20261114-080000-dddd', at: at(4), from: 'robot', title: 'Decided already', action: { type: 'task-merge', ref: '../../etc' } },
    { id: 'S-20261114-070000-eeee', at: at(5), from: 'gemini', title: 'Later, then back', action: { type: 'none' } },
    { id: 'S-20261114-060000-ffff', at: at(6), from: 'gemini', title: 'Later, still hidden', action: { type: 'none' } },
    { id: 'bad id', at: at(1), title: 'skipped' },
    { id: 'S-20261114-080000-dddd', at: at(3.5), status: 'ok' },
    { id: 'S-20261114-090000-aaaa', at: at(2.5), status: 'later' }, { id: 'S-20261114-090000-aaaa', at: at(2.4), status: 'no' }, // newest event wins: no
    { id: 'S-20261114-070000-eeee', at: at(30), status: 'later' },
    { id: 'S-20261114-060000-ffff', at: at(1), status: 'later' },
  ].map(o => JSON.stringify(o)).join('\n') + '\n{broken\n';
  write(path.join(data, 'suggestions.jsonl'), lines);
  const r = D.readSuggestions(data, NOW);
  assert.deepEqual(r.items.map(s => s.id), ['S-20261114-110000-cccc', 'S-20261114-100000-bbbb', 'S-20261114-070000-eeee']);
  const [money, merge, back] = r.items;
  assert.equal(money.money, true);
  assert.deepEqual([merge.action, merge.ref, merge.hasDiff, merge.from, merge.money], ['task-merge', '20261114-100000-fix-timer', true, 'watchkeeper', false]);
  assert.equal(back.action, 'none');
  assert.equal(D.findOpenSuggestion(data, 'S-20261114-090000-aaaa', NOW), null, 'a decided one cannot be decided again');
  assert.equal(D.findOpenSuggestion(data, '../x', NOW), null);
  assert.equal(D.findOpenSuggestion(data, 'S-20261114-100000-bbbb', NOW).title, 'Gemini finished "Fix the timer", tests pass, merge it?');
  assert.deepEqual(D.readSuggestions(path.join(data, 'none'), NOW), { items: [], total: 0 });
});

test('wk-suggest: decide runs with execFile, the exact argv and WK_HOME; a failure gives its one-line reason', async () => {
  const p = pluginFixture(), data = path.join(tmp(), 'wk'), id = 'S-20261114-100000-bbbb';
  const r = await D.decideSuggestion(p.dir, data, id, 'ok');
  assert.equal(r.ok, true, r.err);
  const [c] = p.calls();
  assert.deepEqual([c.script, c.argv, c.wk, c.cwd], ['wk-suggest.mjs', ['decide', id, 'ok'], data, p.dir]);
  assert.ok(!c.env.some(k => /TOKEN|SECRET|KEY|PASSWORD/i.test(k)), 'the child gets a small environment');
  await D.decideSuggestion(p.dir, data, id, 'no', 'Not this week\nplease');
  assert.deepEqual(p.calls()[1].argv, ['decide', id, 'no', '--text', 'Not this week please']);
  write(path.join(p.dir, 'bin', 'FAIL'), '');
  const f = await D.decideSuggestion(p.dir, data, id, 'ok');
  assert.deepEqual([f.ok, f.err], [false, 'The repository has uncommitted changes to a touched file.']);
  const before = p.calls().length;
  for (const [i, ch] of [['S-1', 'ok'], [id, 'merge'], [id + ';ls', 'ok']]) assert.equal((await D.decideSuggestion(p.dir, data, i, ch)).ok, false);
  assert.equal(p.calls().length, before, 'nothing ran for a bad id or choice');
  assert.match((await D.decideSuggestion(tmp(), data, id, 'ok')).err, /no bin\/wk-suggest\.mjs/);
});

// ---------------------------------------------------------------- Gemini
test('wk-task: add runs with the exact argv; "Let Watchkeeper choose" sends no kind', async () => {
  const p = pluginFixture(), data = path.join(tmp(), 'wk'), repo = tmp();
  const r = await D.addTask(p.dir, data, { repo, title: 'Fix the timer', text: '- step one\n- step two', kind: 'code' });
  assert.deepEqual([r.ok, r.out], [true, '20261114-120000-new-task']);
  assert.deepEqual(p.calls()[0].argv, ['add', '--repo', repo, '--title', 'Fix the timer', '--kind', 'code', '--text', '- step one\n- step two', '--from', 'owner']);
  assert.equal(p.calls()[0].wk, data);
  await D.addTask(p.dir, data, { repo, title: 'Tidy the README', text: '', kind: 'auto' });
  assert.deepEqual(p.calls()[1].argv, ['add', '--repo', repo, '--title', 'Tidy the README', '--text', 'Tidy the README', '--from', 'owner']);
  const n = p.calls().length;
  for (const bad of [{ repo: '', title: 'x', kind: 'code' }, { repo: 'rel/path', title: 'x', kind: 'code' }, { repo: path.join(repo, 'missing'), title: 'x', kind: 'code' },
    { repo, title: '', kind: 'code' }, { repo, title: 'x', kind: 'sudo' }]) assert.equal((await D.addTask(p.dir, data, bad)).ok, false, JSON.stringify(bad));
  assert.equal(p.calls().length, n, 'nothing ran');
});

test('tasks, change.diff, Gemini sessions and the config are read safely', () => {
  const data = tmp(), t = (id, meta, diff) => { write(path.join(data, 'tasks', id, 'meta.json'), JSON.stringify({ id, ...meta })); if (diff) write(path.join(data, 'tasks', id, 'change.diff'), diff); };
  t('20261114-090000-queued-one', { title: 'Queued one', kind: 'quick', model: 'gemini-4-hydrogen-medium', status: 'queued', created_at: '2026-11-14T09:00:00Z' });
  t('20261114-100000-verified-one', { title: 'Verified one', kind: 'code', model: 'gemini-4-hydrogen-xhigh', model_used: 'gemini-4-hydrogen-high', status: 'verified', created_at: '2026-11-14T10:00:00Z' }, 'diff');
  t('20261114-110000-odd-one', { title: '<b>x</b>', kind: 'rm', status: 'exploded' });
  t('20261114-120000-wrong-id', { id: 'other' });
  write(path.join(data, 'tasks', 'not-an-id', 'meta.json'), '{}');
  const r = D.readTasks(data);
  assert.deepEqual(r.items.map(x => [x.id, x.status, x.kind, x.hasDiff]), [['20261114-110000-odd-one', 'unknown', '', false], ['20261114-100000-verified-one', 'verified', 'code', true], ['20261114-090000-queued-one', 'queued', 'quick', false]]);
  assert.equal(r.items[1].modelUsed, 'gemini-4-hydrogen-high');
  assert.equal(D.taskDiffFile(data, '20261114-100000-verified-one'), path.join(data, 'tasks', '20261114-100000-verified-one', 'change.diff'));
  assert.equal(D.taskDiffFile(data, '../../etc/passwd'), null);
  assert.equal(D.taskDiffFile(data, '20261114-090000-queued-one'), null, 'no diff yet');
  fs.symlinkSync('/etc/hosts', path.join(data, 'tasks', '20261114-090000-queued-one', 'change.diff'));
  assert.equal(D.taskDiffFile(data, '20261114-090000-queued-one'), null, 'a link is never opened');
  // Gemini sessions: one row per conversation, active = distinct conversations in the last 10 minutes
  const at = m => new Date(NOW - m * 60e3).toISOString();
  write(path.join(data, 'gemini', 'sessions.jsonl'), [
    { at: at(30), conversation_id: 'c1', model: 'gemini-4-hydrogen-xhigh', workspace: '/Users/o/Projects/app', reason: 'stop' },
    { at: at(5), conversation_id: 'c1', model: 'gemini-4-hydrogen-xhigh', workspace: '/Users/o/Projects/app/', reason: 'stop' },
    { at: at(2), conversation_id: 'c2', model: 'gemini-3.8-flash-medium', workspace: '/Users/o/site', reason: 'stop' },
    { at: at(90), conversation_id: 'c3', model: '', workspace: '', reason: 'stop' },
  ].map(o => JSON.stringify(o)).join('\n') + '\nnot json\n');
  const g = D.readGeminiSessions(data, NOW);
  assert.equal(g.active, 2);
  assert.deepEqual(g.items.map(x => [x.id, x.folder]), [['c2', 'site'], ['c1', 'app'], ['c3', '']]);
  // config: present (only the known kinds), or missing
  const p = pluginFixture(), none = pluginFixture({ config: false });
  const c = D.readGeminiConfig(p.dir);
  assert.equal(c.found, true);
  assert.match(c.prompt, /^Every hour: if ~\/\.wk\/KILL exists, stop\./);
  assert.deepEqual(Object.keys(c.routes).sort(), ['code', 'read'], 'an unknown kind in the file is ignored');
  assert.deepEqual(D.readGeminiConfig(none.dir), { found: false, prompt: '', routes: {} });
  assert.deepEqual(D.readGeminiConfig('relative'), { found: false, prompt: '', routes: {} });
});

test('inbox: a decision row has the brief\'s shape; bad refs and choices are refused', () => {
  const data = path.join(tmp(), 'wk');
  const e = D.appendInbox(data, 'decision', { ref: 'Q106', choice: 'ok', title: 'Switch on the add-on?', text: 'OK: switch on' }, new Date(NOW));
  assert.deepEqual(e, { at: new Date(NOW).toISOString(), kind: 'decision', ref: 'Q106', choice: 'ok', title: 'Switch on the add-on?', text: 'OK: switch on' });
  D.appendInbox(data, 'decision', { ref: 'S-20261114-100000-bbbb', choice: 'later', title: 'x' });
  assert.equal(fs.statSync(D.inboxFile(data)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(D.inboxFile(data), 'utf8').trim().split('\n').length, 2);
  for (const d of [{ ref: 'Q1; rm', choice: 'ok' }, { ref: 'Q1', choice: 'merge' }, { ref: '../x', choice: 'ok' }, null]) assert.throws(() => D.appendInbox(data, 'decision', d));
  assert.equal(D.readInbox(data).length, 0, '"Last 10 sent" still lists only recommendations and rules');
  assert.equal(D.validateMessage({ cmd: 'send', kind: 'decision', text: 'x' }).ok, false, 'the note box cannot write a decision');
});

// ---------------------------------------------------------------- render
const base = (over = {}) => ({ now: NOW, paths: { home: '/h', dataDir: '/h/.wk', pluginPath: '/h/p', claudeDir: '/h/.claude' }, pace: { state: 'no-meter' }, kill: { on: false, file: '/h/.wk/KILL' },
  ledger: { missing: true, totals: {}, top: [], wakeups: [], bad: 0 }, sessions: { missing: false, sessions: [], more: 0 }, locks: { missing: true, locks: [] }, inbox: [],
  questions: { available: true, items: [], total: 0, hidden: 0 }, suggestions: { items: [] }, tasks: { items: [], total: 0 }, gemini: { items: [], active: 0 }, geminiConfig: { found: false, routes: {} }, ...over });

test('render: Waiting for you, with OK only where a recommendation exists, the money note under the buttons, and Show all', () => {
  const { orch } = orchFixture();
  const q = D.readQuestions(orch, NOW);
  assert.match(R.renderWaiting(base()), /Nothing waits for you\./);
  const html = R.renderWaiting(base({ questions: q }));
  const row = n => html.slice(html.indexOf(`data-q="${n}"`), html.indexOf('</li>', html.indexOf(`data-q="${n}"`)));
  assert.match(row('104'), /data-cmd="okQuestion" data-n="104"/);
  assert.doesNotMatch(row('105'), /okQuestion/, 'no recommendation: no OK');
  assert.match(row('105'), /Answer…/);
  assert.match(row('105'), /Later/);
  assert.match(row('104'), /Q104 · from T-210 · 13 Nov/);
  assert.match(row('104'), /<span class="rec-label">Recommended:<\/span> yes, at the top\./);
  assert.match(row('106'), /data-money="1"/);
  assert.ok(row('106').indexOf('data-confirm="q106"') > row('106').indexOf('Later</button>'), 'the money note comes after the buttons');
  assert.match(row('106'), /About money, legal wording or an account\. Press OK again to confirm\./);
  assert.doesNotMatch(row('104'), /data-confirm/);
  // more than five: the rest start hidden behind "Show all N"
  const many = { available: true, hidden: 0, total: 8, items: Array.from({ length: 8 }, (_, i) => ({ n: String(200 - i), date: '14 Nov', from: '', text: 'Question ' + i + ' ' + 'word '.repeat(90), rec: '', money: false })) };
  const mh = R.renderWaiting(base({ questions: many }));
  assert.equal((mh.match(/class="wait wait-extra" data-q="\d+" hidden>/g) || []).length, 3);
  assert.match(mh, /Show all 8/);
  assert.match(mh, /data-cmd="more"/, 'a long text gets More');
  assert.match(R.renderWaiting(base({ questions: { ...q, hidden: 2 } })), /2 questions hidden for 24 hours with Later\./);
});

test('render: suggestions and the Gemini queue escape what agents wrote; Show the change only with a diff', () => {
  const evil = '<img src=x onerror=alert(1)>"\'`&';
  const s = { items: [
    { id: 'S-20261114-100000-bbbb', at: NOW, from: 'watchkeeper', title: evil, detail: evil, action: 'task-merge', ref: '20261114-100000-fix-timer', hasDiff: true, money: false },
    { id: 'S-20261114-110000-cccc', at: NOW, from: 'gemini', title: 'Raise the price?', detail: '', action: 'none', ref: '', hasDiff: false, money: true },
  ] };
  const t = { total: 3, items: [
    { id: '20261114-100000-fix-timer', title: evil, kind: 'code', model: 'gemini-4-hydrogen-xhigh', modelUsed: evil, status: 'verified', at: NOW - 3600e3, hasDiff: true, note: evil },
    { id: '20261114-090000-queued', title: 'Queued', kind: '', model: '', modelUsed: '', status: 'queued', at: NOW, hasDiff: true, note: '' },
  ] };
  const m = base({ suggestions: s, tasks: t, gemini: { active: 1, items: [{ at: NOW, id: 'c', model: evil, folder: evil }] } });
  const all = Object.values(R.renderSections(m)).filter(v => typeof v === 'string').join('\n');
  assert.ok(!all.includes('<img'), 'no raw tag');
  assert.ok(all.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const w = R.renderWaiting(m);
  assert.match(w, /OK, go ahead/); assert.match(w, /Not now/); assert.match(w, />No</);
  assert.equal((w.match(/data-cmd="openTaskDiff" data-id="20261114-100000-fix-timer"/g) || []).length, 1, 'task-merge with a diff: Show the change');
  assert.match(w, /data-confirm="sS-20261114-110000-cccc"/, 'a money suggestion asks for a second press');
  const g = R.renderGemini(m);
  assert.match(g, /Checked: tests pass/);
  assert.match(g, /suggested gemini-4-hydrogen-xhigh · used &lt;img/);
  assert.equal((g.match(/Show the change/g) || []).length, 1, 'a queued task has no Show the change, even with a file');
  assert.match(g, /1 older task in <code>~\/\.wk\/tasks<\/code>/);
  assert.match(R.renderSessions(m), /Gemini in Antigravity: 1 session active in the last 10 minutes\./);
  assert.match(R.renderRoutes(m), /config\/gemini\.json<\/code> is missing/);
  assert.match(R.renderRoutes(m), /a plugin cannot set it/);
  const withCfg = R.renderRoutes(base({ geminiConfig: { found: true, routes: { code: { model: 'gemini-4-hydrogen-xhigh', fallback: 'gemini-4-hydrogen-high', for: 'everyday coding' } } } }));
  assert.match(withCfg, /Code<\/span> <span class="num">gemini-4-hydrogen-xhigh<\/span>/);
  assert.match(withCfg, /if your plan lacks it: gemini-4-hydrogen-high/);
  assert.match(R.renderGemini(base()), /No tasks yet\./);
  assert.match(R.renderGemini(base()), /No Gemini sessions recorded yet\./);
});

test('render: the page has the two new sections, hidden until the data says so; strangers get none of it', async () => {
  const html = R.renderPage({ nonce: 'abc', cspSource: 'x', styleUris: [], scriptUri: 'x' });
  assert.match(html, /<section aria-labelledby="h-waiting" data-needs="waiting" hidden>/);
  assert.match(html, /<section aria-labelledby="h-gemini" data-needs="gemini" hidden>/);
  assert.ok(html.indexOf('h-waiting') < html.indexOf('h-pace'), 'Waiting for you sits right under the status line');
  assert.ok(html.indexOf('</header>') < html.indexOf('h-waiting'));
  assert.match(html, /Gemini takes tasks when you type \/wk-take-task in Antigravity, or from an automation you set up once\./);
  assert.match(html, /data-cmd="copyAutomation">Copy the automation prompt</);
  assert.match(html, /<option value="auto">Let Watchkeeper choose<\/option>/);
  assert.equal((html.match(/<option value="(read|quick|code|ui|plan|hard|review)">/g) || []).length, 7);
  // a stranger: no plugin, an orchestration folder with questions is not read and the new parts are empty
  const home = tmp(), { orch } = orchFixture();
  const m = await D.collect({ orchestrationDir: orch }, Date.now(), { home });
  assert.equal(m.questions.available, false);
  const sec = R.renderSections(m);
  assert.deepEqual([sec.mode, sec.waiting, sec.gemini, sec.routes, sec.show.waiting, sec.show.gemini], ['sessions', '', '', '', false, false]);
  assert.doesNotMatch(sec.sessions, /Gemini/);
  // with the plugin: the questions are read and Waiting shows, from the folder remote.json names (never a workspace's own)
  const p = pluginFixture();
  fs.mkdirSync(path.join(home, 'wk'), { recursive: true });
  const bare = await D.collect({ pluginPath: p.dir, dataDir: path.join(home, 'wk'), claudeDir: path.join(home, 'c'), orchestrationDir: orch }, Date.now(), { home });
  assert.equal(bare.questions.available, false, 'the orchestrationDir setting alone lists no questions');
  fs.writeFileSync(path.join(home, 'wk', 'remote.json'), JSON.stringify({ orchestration: orch }));
  const fm = await D.collect({ pluginPath: p.dir, dataDir: path.join(home, 'wk'), claudeDir: path.join(home, 'c'), orchestrationDir: orch }, Date.now(), { home });
  const fs2 = R.renderSections(fm);
  assert.deepEqual([fs2.mode, fs2.show.waiting, fs2.show.gemini, fm.questions.items.length, fm.geminiConfig.found], ['full', true, true, 3, true]);
  assert.match(fs2.waiting, /Q106/);
});

// ---------------------------------------------------------------- P2-223 fix round (Desk B)
test('M4: a verified task says "tests pass" only when a test was set; the form hint is honest', () => {
  const data = tmp();
  const t = (id, meta) => write(path.join(data, 'tasks', id, 'meta.json'), JSON.stringify({ id, title: id, status: 'verified', ...meta }));
  t('20261114-100000-with-test', { test: 'npm test' });
  t('20261114-090000-no-test', {});
  const r = D.readTasks(data);
  assert.deepEqual(r.items.map(x => [x.id, x.hasTest]), [['20261114-100000-with-test', true], ['20261114-090000-no-test', false]]);
  const g = R.renderGemini(base({ tasks: { total: 2, items: r.items } }));
  assert.equal((g.match(/Checked: tests pass/g) || []).length, 1);
  assert.equal((g.match(/Checked: files only, no test set/g) || []).length, 1);
  assert.ok(g.indexOf('Checked: tests pass') < g.indexOf('Checked: files only'), 'each badge sits on its own task');
  const page = Object.values(R.renderSections(base())).filter(v => typeof v === 'string').join('\n') + R.renderPage({ nonce: 'n', cspSource: 'x', styleUris: [], scriptUri: 'x' });
  assert.ok(page.includes('Gemini works in a copy. Watchkeeper checks the changed files, and the test when one is set, before it asks you.'));
  assert.ok(!/and the tests before it asks you/.test(page));
});

test('S6: the optional test command goes to wk-task as one --test argument; empty adds none', async () => {
  const p = pluginFixture(), data = path.join(tmp(), 'wk'), repo = tmp();
  await D.addTask(p.dir, data, { repo, title: 'Fix', text: 'x', kind: 'code', test: '  npm test\n&& rm -rf / ' });
  assert.deepEqual(p.calls()[0].argv, ['add', '--repo', repo, '--title', 'Fix', '--kind', 'code', '--text', 'x', '--test', 'npm test && rm -rf /', '--from', 'owner']);
  await D.addTask(p.dir, data, { repo, title: 'Fix', text: 'x', kind: 'code', test: '   ' });
  await D.addTask(p.dir, data, { repo, title: 'Fix', text: 'x', kind: 'code' });
  assert.ok(!p.calls()[1].argv.includes('--test') && !p.calls()[2].argv.includes('--test'));
  await D.addTask(p.dir, data, { repo, title: 'Fix', text: 'x', kind: 'auto', test: 'a'.repeat(900) });
  assert.equal(p.calls()[3].argv[p.calls()[3].argv.indexOf('--test') + 1].length, 500);
  const ok = m => D.validateMessage(m);
  assert.deepEqual(ok({ cmd: 'addTask', title: 'T', test: ' npm\ntest ' }).msg, { cmd: 'addTask', title: 'T', text: '', kind: 'auto', test: 'npm test' });
  assert.equal('test' in ok({ cmd: 'addTask', title: 'T', test: '' }).msg, false);
  assert.equal(ok({ cmd: 'addTask', title: 'T', test: 'a'.repeat(501) }).ok, false);
  assert.equal(ok({ cmd: 'addTask', title: 'T', test: 5 }).ok, false);
  const page = R.renderPage({ nonce: 'n', cspSource: 'x', styleUris: [], scriptUri: 'x' });
  assert.match(page, /<input id="task-test"[^>]*placeholder="npm test \(optional\)"/);
});

test('S7: a merge may take 10 minutes; the page shows Merging… and disables the buttons', () => {
  assert.equal(D.MERGE_TIMEOUT_MS, 600000);
  assert.match(D.decideSuggestion.toString(), /timeoutMs = MERGE_TIMEOUT_MS/);
  const s = { items: [{ id: 'S-20261114-100000-bbbb', at: NOW, from: 'watchkeeper', title: 't', detail: '', action: 'task-merge', ref: '20261114-100000-fix-timer', hasDiff: false, money: false },
    { id: 'S-20261114-110000-cccc', at: NOW, from: 'claude', title: 'u', detail: '', action: 'none', ref: '', hasDiff: false, money: false }] };
  const w = R.renderWaiting(base({ suggestions: s }));
  assert.equal((w.match(/data-merge="1"/g) || []).length, 1, 'only the merge button carries the merge mark');
  const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  assert.match(js, /m\.type === 'merging'/);
  assert.match(js, /'Merging…'/);
  assert.match(js, /b\.disabled = !!on/);
});

test('S1d: one plain line under the model table says what the hook pass decision is (allow, ask, unknown)', async () => {
  const data = tmp(), file = path.join(data, 'antigravity-hook.json');
  assert.deepEqual(D.readHookPass(data), { pass: 'unknown' }, 'no file');
  write(file, '{not json');
  assert.deepEqual(D.readHookPass(data), { pass: 'unknown' }, 'bad JSON');
  write(file, JSON.stringify({ pass: 'sudo' }));
  assert.deepEqual(D.readHookPass(data), { pass: 'unknown' }, 'unknown value');
  write(file, JSON.stringify({ pass: 'allow', preset: 'AGENT_PERMISSION_PRESET_TURBO', policy: 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER', detected_at: '2026-11-14T10:00:00Z', source: 'detected' }));
  assert.deepEqual(D.readHookPass(data), { pass: 'allow' }, 'only the pass is kept');
  const words = {
    allow: "Gemini's steps run without asking you (your Turbo setting). In Watchkeeper's own tasks it still blocks secrets, pushes, and every step while the stop switch is on.",
    ask: "Antigravity asks you before Gemini's steps. Hourly runs can't do those steps.",
    unknown: 'Install Watchkeeper into Antigravity to set this.' };
  for (const [pass, text] of Object.entries(words)) {
    const html = R.renderRoutes(base({ hookPass: { pass } }));
    assert.ok(html.includes(`<p class="hint hook-pass">${R.esc(text)}</p>`), pass);
    assert.equal((html.match(/hook-pass/g) || []).length, 1);
    assert.ok(html.indexOf('</ul>') < html.indexOf('hook-pass'), 'under the model table');
  }
  assert.match(R.renderRoutes(base()), /Install Watchkeeper into Antigravity to set this\./, 'no field at all: unknown');
  // collect reads it only with the plugin, from the data folder
  const p = pluginFixture(), home = tmp(), d2 = path.join(home, 'wk');
  write(path.join(d2, 'antigravity-hook.json'), JSON.stringify({ pass: 'ask' }));
  const m = await D.collect({ pluginPath: p.dir, dataDir: d2, claudeDir: path.join(home, 'c'), orchestrationDir: path.join(home, 'o') }, Date.now(), { home });
  assert.deepEqual(m.hookPass, { pass: 'ask' });
});
