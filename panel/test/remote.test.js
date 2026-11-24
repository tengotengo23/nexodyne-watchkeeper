'use strict';
// P2-227: jobs, projects and the phone in the panel. Both hosts render; local-only controls only for "antigravity".
// Every file lives in a temp folder: HOME and WK_HOME point there, git runs only on temp repositories.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p227-'));
process.env.HOME = base;
process.env.WK_HOME = path.join(base, 'wk');
const D = require('../src/data');
const R = require('../src/render');
const A = require('../src/actions');

const NOW = Date.UTC(2026, 10, 16, 18, 0, 0);
const HOSTILE = '<img src=x onerror=alert(1)>"\'`&';
const J1 = 'J-20261116-1902-a3f9', J2 = 'J-20261116-1700-0b1c', J3 = 'J-20261115-0900-ffff';
const CRED = 'AbCdEfGhIjKlMnOpQrStUv', CRED2 = 'ZyXwVuTsRqPoNmLkJiHgFe';

function model(over = {}) {
  return {
    now: NOW, paths: { home: base, dataDir: path.join(base, 'wk'), claudeDir: path.join(base, 'claude') }, pluginOk: true,
    pace: { state: 'no-meter' }, kill: { on: false, at: 0, file: path.join(base, 'wk', 'KILL') },
    ledger: { missing: true, totals: { usd: 0, runs: 0, in: 0, cache_read: 0, cache_write: 0, out: 0 }, top: [], wakeups: [], bad: 0 },
    sessions: { missing: false, sessions: [], more: 0 }, locks: { missing: true, locks: [] }, inbox: [], advice: { items: [{ id: 'A-1', status: 'answered', hasAnswer: true, preview: 'p', from: 'gemini', at: NOW }], total: 1 },
    ask: { installed: false, off: false, commandOk: true }, update: { version: null, last: null },
    questions: { available: true, items: [], total: 0, hidden: 0 },
    suggestions: { items: [{ id: 'S-20261116-100000-abcd', title: 'Merge it?', action: 'task-merge', hasDiff: true, ref: 'T-1', from: 'gemini', at: NOW }], total: 1 },
    tasks: { items: [{ id: 'T-1', title: 'Fix', status: 'verified', hasDiff: true, at: NOW }], total: 1 },
    gemini: { items: [], active: 0 }, geminiConfig: { found: false, prompt: '', routes: {} }, hookPass: { pass: 'unknown' },
    jobs: [
      { id: J1, project: 'nexodyne', model: 'sonnet', mode: 'auto', from: 'phone', state: 'running', started_at: NOW - 60000, ended_at: 0, cost_usd: null, turns: null, title: 'Fix the footer', last_text: '',
        tail: [{ n: 1, type: 'init', model: 'claude-sonnet', permissionMode: 'auto' }, { n: 2, type: 'tool', name: 'Bash', short: 'npm test' }, { n: 3, type: 'permission_denied', tool: 'WebFetch' }] },
      { id: J2, project: 'watchkeeper', model: 'opus', mode: 'plan', from: 'panel', state: 'waiting', started_at: NOW - 3600000, ended_at: NOW - 1800000, cost_usd: 1.25, turns: 12, title: 'Plan the bridge', last_text: 'Shall I go on?' },
      { id: J3, project: 'nexodyne', model: 'haiku', mode: 'acceptEdits', from: 'cli', state: 'done', started_at: NOW - 86400000, ended_at: NOW - 80000000, cost_usd: 0.1, turns: 3, title: 'Old', last_text: 'Done.' },
    ],
    projects: [{ key: 'nexodyne', name: 'Nexodyne', path: '~/Projects/nexodyne', kind: 'repo', branch: 'main', git: true, last: { sha7: 'abc1234', at: NOW - 600000, subject: 'T-227: brief' },
      changed: 3, ahead: 1, behind: 0, items: [{ id: 'T-227', status: 'building' }], sessions: 2, gemini: 1, jobs: 1 },
    { key: 'watchkeeper', name: 'Watchkeeper', path: '~/Projects/watchkeeper', kind: 'repo', branch: 'p2-227', git: true, last: null, changed: 0, ahead: null, behind: null, items: [], sessions: 0, gemini: 0, jobs: 0 }],
    projectsFile: { found: true, more: 0 },
    phone: { enabled: false, origin: 'https://panel.example.com', trusted: [{ id: CRED, label: 'iPhone', added_at: NOW - 86400000 }], pending: [{ id: CRED2, label: 'New phone', registered_at: NOW - 60000 }] },
    remote: { enabled: false, origin: 'https://panel.example.com', max_jobs: 2, job_hours: 3, pace_stop_pct: 90 },
    ...over,
  };
}
const web = over => ({ ...model(over), host: 'web' });

test('jobs: the form, each state, the output only on the Mac, a reply box only while waiting, Stop only while running', () => {
  for (const host of ['antigravity', 'web']) {
    const h = R.renderJobs({ ...model(), host });
    for (const id of ['job-project', 'job-prompt', 'job-model', 'job-mode', 'job-turns']) assert.match(h, new RegExp(`id="${id}"`), `${host} ${id}`);
    assert.match(h, /data-cmd="jobStart"/);
    assert.match(h, /<option value="sonnet" selected>Sonnet<\/option>/);
    assert.match(h, /<option value="auto" selected>Edit and run commands \(auto mode\)<\/option>/);
    assert.match(h, /Edit files, no commands/); assert.match(h, /Look and plan only/);
    assert.match(h, new RegExp(`data-job-item="${J1}"[\\s\\S]*data-cmd="jobStop" data-job="${J1}"`));
    assert.match(h, new RegExp(`data-reply="${J2}"[\\s\\S]*data-cmd="jobReply" data-job="${J2}"`));
    assert.equal((h.match(/data-cmd="jobStop"/g) || []).length, 1, 'Stop only on the running job');
    assert.equal((h.match(/data-cmd="jobReply"/g) || []).length, 1, 'a reply box only on the waiting job');
    assert.match(h, /Waiting for your reply/); assert.match(h, /US\$1\.25/); assert.match(h, /12 turns/);
    assert.match(h, new RegExp(`<ol class="job-out" data-job-out="${J3}"`));
  }
  const local = R.renderJobs(model()), w = R.renderJobs(web());
  assert.match(local, /Tool: Bash npm test/); assert.match(local, /Not allowed: WebFetch/); assert.match(local, /Started \(claude-sonnet, auto\)/);
  assert.doesNotMatch(w, /Tool: Bash/, 'the web page fetches the output itself, with textContent');
  assert.match(w, /asks for your passkey each time/); assert.doesNotMatch(local, /passkey/);
  const none = R.renderJobs(model({ jobs: [], projects: [] }));
  assert.doesNotMatch(none, /data-cmd="jobStart"/, 'no project, no form');
  assert.match(none, /wk-projects\.mjs scan/);
});

test('projects: branch, commit, changes, ahead, open items and live counts; the scan hint when there is no list', () => {
  for (const host of ['antigravity', 'web']) {
    const h = R.renderProjects({ ...model(), host });
    assert.match(h, /Nexodyne/); assert.match(h, /~\/Projects\/nexodyne/); assert.match(h, /abc1234/); assert.match(h, /T-227: brief/);
    assert.match(h, /3 changed files/); assert.match(h, /1 ahead/); assert.match(h, /Open: T-227/); assert.match(h, /2 sessions · 1 job · 1 Gemini task/);
    assert.match(h, /p2-227 · clean/);
  }
  const empty = R.renderProjects(model({ projects: [], projectsFile: { found: false, more: 0 } }));
  assert.match(empty, /No projects listed yet/); assert.match(empty, /wk-projects\.mjs scan/);
  assert.match(R.renderProjects(model({ projectsFile: { found: true, more: 4 } })), /4 more projects/);
});

test('phone: Trust, Reject and Switch on only on the Mac; the web says where to do it; off is allowed on both', () => {
  const local = R.renderPhone(model()), w = R.renderPhone(web());
  assert.match(local, new RegExp(`data-cmd="trustKey" data-id="${CRED2}"`)); assert.match(local, new RegExp(`data-cmd="rejectKey" data-id="${CRED2}"`));
  assert.match(local, /data-cmd="remoteOn"/);
  for (const c of ['trustKey', 'rejectKey', 'remoteOn', 'setupPhone']) assert.doesNotMatch(w, new RegExp(`data-cmd="${c}"`), `web has no ${c}`);
  assert.match(w, /Do this in the Watchkeeper panel on your Mac\./);
  assert.match(w, /AbCdEfGh/); assert.match(w, /Waiting for Trust/); assert.match(w, /Phone control is off/);
  const on = { phone: { ...model().phone, enabled: true } };
  assert.match(R.renderPhone(model(on)), /data-cmd="remoteOff"/);
  assert.doesNotMatch(R.renderPhone(web(on)), /data-cmd="remoteOff"/, 'the web page has its own "off" button outside the slot');
  assert.match(R.renderPhone(web(on)), /Phone control is on/);
});

test('the other local-only controls: install ask, open advice, open task diff and copy automation never render on web', () => {
  const w = R.renderSections(web()), local = R.renderSections(model());
  const all = o => Object.values(o).filter(v => typeof v === 'string').join('\n');
  for (const c of ['installAsk', 'openAdvice', 'openTaskDiff', 'copyAutomation', 'trustKey', 'rejectKey', 'remoteOn']) assert.doesNotMatch(all(w), new RegExp(`data-cmd="${c}"`), c);
  for (const c of ['installAsk', 'openAdvice', 'openTaskDiff', 'trustKey', 'rejectKey', 'remoteOn']) assert.match(all(local), new RegExp(`data-cmd="${c}"`), c);
  assert.match(w.waiting, /To see the change: Do this in the Watchkeeper panel on your Mac\./);
  // the web host's status carries the stop switch and the limits; its about says what the page is
  assert.match(w.status, /data-cmd="kill"/); assert.match(w.status, /At most 2 jobs at once, each up to 3 hours/); assert.match(w.status, /90%/);
  assert.doesNotMatch(local.status, /data-cmd="kill"/, 'the panel keeps its own switch section');
  assert.match(w.about, /signed with a phone key you trusted on the Mac/); assert.doesNotMatch(w.about, /writes nothing/);
  // the panel's about: how to install the plugin, in the README's own lines (one step, then the two for older Claude Code); the setting only for a copy kept elsewhere
  assert.ok(local.about.includes('In Claude Code, type: <code>/plugin install watchkeeper --marketplace tengotengo23/nexodyne-watchkeeper</code> (before Claude Code 2.1.275, two lines:'));
  assert.ok(local.about.includes('<code>/plugin marketplace add tengotengo23/nexodyne-watchkeeper</code> and <code>/plugin install watchkeeper@nexodyne</code>'));
  assert.match(local.about, /finds the plugin by itself; set <code>watchkeeper\.pluginPath<\/code> in Settings only for a copy kept somewhere else/);
  assert.doesNotMatch(local.about, /not public yet/);
  assert.match(R.renderPage({ nonce: 'n', cspSource: 'x', styleUris: [], scriptUri: 'x' }), /<p class="hint" id="note-help">A rule change is only saved, in <code>~\/\.wk\/owner-inbox\.jsonl<\/code>\. No session reads it by itself: ask Claude Code to read that file, make the change, and approve it in that chat\.<\/p>/);
  for (const k of ['status', 'waiting', 'jobs', 'projects', 'sessions', 'gemini', 'phone', 'about']) assert.equal(typeof w[k], 'string', k);
  assert.deepEqual([w.show.jobs, w.show.projects, w.show.phone], [true, true, true]);
  const lite = R.renderSections({ ...model(), pace: { state: 'no-plugin' } });
  assert.deepEqual([lite.jobs, lite.projects, lite.phone, lite.show.jobs, lite.show.projects, lite.show.phone], ['', '', '', false, false, false]);
});

test('escaping: what agents, git and the phone wrote never becomes markup, in both hosts', () => {
  const bad = model({
    jobs: [{ id: J1, project: HOSTILE, model: HOSTILE, mode: HOSTILE, from: HOSTILE, state: HOSTILE, started_at: NOW, title: HOSTILE, last_text: HOSTILE, cost_usd: 1, turns: 1,
      tail: [{ n: 1, type: 'text', text: HOSTILE }, { n: 2, type: HOSTILE, text: HOSTILE }, { n: 3, type: 'tool', name: HOSTILE, short: HOSTILE }] }],
    projects: [{ key: 'x', name: HOSTILE, path: HOSTILE, branch: HOSTILE, git: true, last: { sha7: HOSTILE, at: NOW, subject: HOSTILE }, changed: 1, items: [{ id: HOSTILE }], sessions: 0, gemini: 0, jobs: 0 }],
    phone: { enabled: false, trusted: [{ id: HOSTILE, label: HOSTILE, added_at: NOW }], pending: [{ id: HOSTILE, label: HOSTILE, registered_at: NOW }] },
    mac: { name: HOSTILE, free_mb: 2000, low_ram: false }, bridge: { version: HOSTILE, pushed_at: NOW },
  });
  for (const host of ['antigravity', 'web']) {
    const s = R.renderSections({ ...bad, host });
    for (const k of ['jobs', 'projects', 'phone', 'status', 'about']) {
      assert.doesNotMatch(s[k], /<img/, `${host} ${k}`);
      assert.doesNotMatch(s[k], /"'`&(?!amp;|lt;|gt;|quot;|#)/, `${host} ${k}: raw quotes`);
    }
    assert.match(s.jobs, /&lt;img src=x onerror=alert\(1\)&gt;/);
  }
  // missing fields never throw
  const bare = { now: NOW, pace: { state: 'no-meter' }, kill: {}, sessions: { sessions: [] } };
  for (const host of ['antigravity', 'web']) for (const f of ['renderJobs', 'renderProjects', 'renderPhone']) assert.equal(typeof R[f]({ ...bare, host }), 'string');
});

test('the page: three new sections hidden until the data says so, with their own feedback lines; the old six stay', () => {
  const page = R.renderPage({ nonce: 'n', cspSource: 'c', scriptUri: 's' });
  for (const k of ['jobs', 'projects', 'phone']) assert.match(page, new RegExp(`data-needs="${k}" hidden><h2 id="h-${k}">`), k);
  assert.match(page, /id="feedback-jobs"/); assert.match(page, /id="feedback-phone"/);
  assert.equal((page.match(/data-needs="plugin"/g) || []).length, 7); // P2-272 P3: 6 to 7, the usage card is one more plugin section; nothing cut
  // P2-272 P3 fixes (S1): the drawer groups "Tasks, jobs and sessions" before "Projects, spend and advice"
  assert.ok(page.indexOf('data-slot="waiting"') < page.indexOf('data-slot="jobs"') && page.indexOf('data-slot="jobs"') < page.indexOf('data-slot="sessions"')
    && page.indexOf('data-slot="sessions"') < page.indexOf('data-slot="projects"'), 'waiting, jobs, sessions, projects');
});

test('messages: the new commands are checked against closed sets and patterns', () => {
  const ok = m => D.validateMessage(m);
  assert.deepEqual(ok({ cmd: 'jobStart', project: 'nexodyne', prompt: ' Fix it \u0007', model: '', mode: '' }).msg, { cmd: 'jobStart', project: 'nexodyne', prompt: 'Fix it', model: 'sonnet', mode: 'auto' });
  assert.equal(ok({ cmd: 'jobStart', project: 'nexodyne', prompt: 'x', model: 'opus', mode: 'plan', max_turns: 40 }).msg.max_turns, 40);
  for (const bad of [{ project: '../etc' }, { project: 'Big' }, { prompt: '' }, { prompt: 'x'.repeat(8001) }, { model: 'gpt' }, { mode: 'bypassPermissions' }, { mode: 'dontAsk' },
    { max_turns: 0 }, { max_turns: 401 }, { max_turns: 1.5 }]) {
    assert.equal(ok({ cmd: 'jobStart', project: 'nexodyne', prompt: 'x', ...bad }).ok, false, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(ok({ cmd: 'jobReply', job: J1, prompt: 'go on' }).ok, true);
  assert.equal(ok({ cmd: 'jobReply', job: 'J-1', prompt: 'go on' }).ok, false);
  assert.equal(ok({ cmd: 'jobReply', job: J1, prompt: ' ' }).ok, false);
  assert.equal(ok({ cmd: 'jobStop', job: J1 }).ok, true); assert.equal(ok({ cmd: 'jobStop', job: '../x' }).ok, false);
  assert.equal(ok({ cmd: 'trustKey', id: CRED }).ok, true); assert.equal(ok({ cmd: 'rejectKey', id: 'short' }).ok, false); assert.equal(ok({ cmd: 'trustKey', id: 'a/b'.repeat(8) }).ok, false);
  assert.equal(ok({ cmd: 'remoteOn' }).ok, true); assert.equal(ok({ cmd: 'remoteOff' }).ok, true);
  assert.equal(ok({ cmd: 'setupPhone' }).ok, false, 'setupPhone is the web page\'s alone');
});

test('readers: jobs newest first with summaries, phone keys without key material, remote.json defaults', () => {
  const wk = fs.mkdtempSync(path.join(base, 'wk-'));
  const job = (id, meta, prompt, events = []) => {
    fs.mkdirSync(path.join(wk, 'jobs', id), { recursive: true });
    fs.writeFileSync(path.join(wk, 'jobs', id, 'meta.json'), JSON.stringify({ id, ...meta }));
    fs.writeFileSync(path.join(wk, 'jobs', id, 'prompt-1.txt'), prompt);
    fs.writeFileSync(path.join(wk, 'jobs', id, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  };
  job(J1, { project: 'nexodyne', model: 'sonnet', mode: 'auto', from: 'phone', state: 'running', started_at: NOW, last_text: 'x'.repeat(400) }, 'Work in shops/ (project shops).\nFix the footer\nmore',
    [{ n: 1, type: 'init', model: 'm', permissionMode: 'auto' }, { n: 2, type: 'text', text: 'y'.repeat(900) }]);
  job(J3, { project: 'nexodyne', model: 'gpt', mode: 'yolo', from: 'mars', state: 'odd' }, '');
  fs.mkdirSync(path.join(wk, 'jobs', 'not-a-job'));
  const js = D.readJobs(wk);
  assert.deepEqual(js.map(j => j.id), [J1, J3]);
  assert.equal(js[0].title, 'Fix the footer', 'the folder line is not the title');
  assert.equal(js[0].last_text.length, 300);
  assert.deepEqual([js[1].model, js[1].mode, js[1].from, js[1].state, js[1].title], ['', '', 'cli', 'failed', 'Untitled job']);
  assert.equal(js[0].tail.length, 2); assert.equal(js[0].tail[1].text.length, 500);
  assert.deepEqual(D.readJobs(path.join(wk, 'none')), []);
  fs.writeFileSync(path.join(wk, 'remote-keys.json'), JSON.stringify({ keys: [{ id: CRED, spki: 'SECRET-SHAPED-SPKI', label: 'iPhone\n<b>', added_at: 5, sign_count: 3 }, { id: 'x' }], rejected: [] }));
  fs.writeFileSync(path.join(wk, 'remote-pending.json'), JSON.stringify({ keys: [{ id: CRED2, spki: 'S', label: '', registered_at: 9 }] }));
  const ph = D.readPhone(wk);
  assert.deepEqual(ph.trusted, [{ id: CRED, label: 'iPhone <b>', added_at: 5 }]);
  assert.deepEqual(ph.pending, [{ id: CRED2, label: 'Phone', registered_at: 9 }]);
  assert.doesNotMatch(JSON.stringify(ph), /spki|SECRET/);
  assert.equal(ph.enabled, false);
  fs.writeFileSync(path.join(wk, 'remote.json'), JSON.stringify({ enabled: 'yes', max_jobs: '9', port: 2222 }));
  const r = D.readRemote(wk);
  assert.deepEqual([r.enabled, r.max_jobs, r.port, r.rp_id], [false, 2, 2222, ''], 'enabled only when strictly true; wrong types fall back (no built-in server)');
  fs.writeFileSync(path.join(wk, 'remote.json'), JSON.stringify({ enabled: true }));
  assert.equal(D.readPhone(wk).enabled, true);
});

test('projects: git read-only on temp repositories, a monorepo folder scoped to its path, open PHASE.md items, cache', async () => {
  const root = fs.mkdtempSync(path.join(base, 'pr-')), wk = path.join(root, 'wk');
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' });
  const mono = path.join(root, 'Projects', 'mono');
  fs.mkdirSync(path.join(mono, 'shop'), { recursive: true }); fs.mkdirSync(path.join(mono, 'worklog'));
  g(mono, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(mono, 'shop', 'package.json'), '{}');
  fs.writeFileSync(path.join(mono, 'worklog', 'PHASE.md'), '| ID | Area | Title | Status |\n|---|---|---|---|\n| T-1 | shop | shop/ footer | building |\n| T-2 | shop | shop/ old | done 1 Nov |\n| T-3 | site | other | open |\n');
  g(mono, 'add', '.'); g(mono, 'commit', '-q', '-m', 'first <b>');
  fs.writeFileSync(path.join(mono, 'shop', 'new.txt'), 'x'); fs.writeFileSync(path.join(mono, 'top.txt'), 'x');
  fs.mkdirSync(wk);
  fs.writeFileSync(path.join(wk, 'projects.json'), JSON.stringify({ projects: [
    { key: 'mono', name: 'Mono', path: '~/' + path.relative(base, mono), kind: 'repo' },
    { key: 'shop', name: 'Shop', path: path.join(mono, 'shop'), kind: 'folder', repo: mono },
    { key: 'Bad Key', name: 'x', path: '/' }, { key: 'gone', name: 'Gone', path: path.join(root, 'gone'), kind: 'repo' }] }));
  const jobs = [{ id: J1, project: 'shop', state: 'running' }, { id: J2, project: 'shop', state: 'done' }];
  const sessions = { sessions: [{ active: true, project: 'mono' }, { active: false, project: 'mono' }] };
  const p = await D.readProjects(wk, { home: base, now: NOW, sessions, jobs });
  assert.equal(p.found, true);
  assert.deepEqual(p.items.map(x => x.key), ['mono', 'shop', 'gone'], 'a bad key is dropped');
  const [m, s, gone] = p.items;
  assert.equal(m.path, '~/' + path.relative(base, mono));
  assert.deepEqual([m.branch, m.git, m.changed, m.last.subject, m.last.sha7.length, m.sessions], ['main', true, 2, 'first <b>', 7, 1]);
  assert.deepEqual([s.changed, s.jobs, s.items.map(i => i.id)], [1, 1, ['T-1']], 'the folder counts only its own changes and items');
  assert.deepEqual(m.items.map(i => i.id), ['T-3', 'T-1'], 'open rows only, newest last in the file first');
  assert.deepEqual([gone.git, gone.last, gone.changed], [false, null, null]);
  // the git facts are kept for 60 s; the live counts are not
  fs.writeFileSync(path.join(mono, 'more.txt'), 'x');
  const again = await D.readProjects(wk, { home: base, now: NOW + 30000, sessions: { sessions: [] }, jobs: [] });
  assert.deepEqual([again.items[0].changed, again.items[0].sessions], [2, 0]);
  const later = await D.readProjects(wk, { home: base, now: NOW + 61000 });
  assert.equal(later.items[0].changed, 3);
  assert.deepEqual(await D.readProjects(path.join(root, 'nowk')), { found: false, items: [], more: 0 });
  assert.equal(fs.existsSync(path.join(mono, '.git', 'index.lock')), false);
});

test('projects: reading a repository runs no command its own git config names (fsmonitor, filters, gpg, submodules, transports)', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(base, 'trap-')), wk = path.join(root, 'wk'), marks = path.join(root, 'marks');
  fs.mkdirSync(wk); fs.mkdirSync(marks);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const g = (cwd, ...a) => String(execFileSync('git', ['-C', cwd, ...a], { env, stdio: 'pipe' }));
  // each trap leaves a mark when it runs; a filter passes the content through, the fsmonitor stub reads nothing
  const trap = (name, pass = true) => { const f = path.join(root, name + '.sh'); fs.writeFileSync(f, `#!/bin/sh\ntouch '${path.join(marks, name)}'\n${pass ? 'cat\n' : ''}`, { mode: 0o755 }); return f; };
  const repoWith = (dir, files) => { fs.mkdirSync(dir, { recursive: true }); g(dir, 'init', '-q', '-b', 'main'); for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), t); g(dir, 'add', '.'); g(dir, 'commit', '-q', '-m', 'one'); };
  const sub = path.join(root, 'subsrc'), repo = path.join(root, 'Projects', 'trap'), odd = path.join(root, 'Projects', 'odd');
  repoWith(sub, { 's.txt': 's\n', '.gitattributes': '*.txt filter=w\n' });
  repoWith(repo, { 'a.txt': 'a\n', 'b.md': 'b\n', '.gitattributes': '*.txt filter=evil\n*.md filter=inc\n' });
  g(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub'); g(repo, 'commit', '-q', '-m', 'sub');
  repoWith(odd, { 'a.txt': 'a\n', '.gitattributes': '*.txt filter=e=il\n' });
  g(repo, 'config', 'core.fsmonitor', trap('fsmonitor', false));
  g(repo, 'config', 'filter.evil.clean', trap('clean'));
  fs.writeFileSync(path.join(root, 'inc.cfg'), `[filter "inc"]\n\tclean = ${trap('included')}\n`);
  g(repo, 'config', 'include.path', path.join(root, 'inc.cfg'));
  g(path.join(repo, 'sub'), 'config', 'filter.w.clean', trap('submodule'));
  g(odd, 'config', 'filter.e=il.clean', trap('odd'));
  // a remote that is a command, which the repository allows for itself: any fetch, a lazy one included, would run it
  g(repo, 'config', 'remote.origin.url', `ext::sh -c touch% ${path.join(marks, 'ext')}`); g(repo, 'config', 'protocol.ext.allow', 'always');
  // a signed-looking commit: with log.showSignature, plain git log runs gpg.program on it
  const tree = g(repo, 'rev-parse', 'HEAD^{tree}').trim(), parent = g(repo, 'rev-parse', 'HEAD').trim();
  const body = `tree ${tree}\nparent ${parent}\nauthor t <t@x> 1700000000 +0000\ncommitter t <t@x> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n`;
  g(repo, 'update-ref', 'HEAD', String(execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], { env, input: body })).trim());
  g(repo, 'config', 'log.showSignature', 'true'); g(repo, 'config', 'gpg.program', trap('gpg'));
  // stat data no longer matches the index, so git must hash these files again (and would filter them)
  const old = new Date(Date.now() - 3600e3);
  for (const f of [path.join(repo, 'a.txt'), path.join(repo, 'b.md'), path.join(repo, 'sub', 's.txt'), path.join(odd, 'a.txt')]) fs.utimesSync(f, old, old);
  fs.writeFileSync(path.join(repo, 'c.txt'), 'new\n');
  fs.writeFileSync(path.join(wk, 'projects.json'), JSON.stringify({ projects: [
    { key: 'trap', name: 'Trap', path: repo, kind: 'repo' }, { key: 'odd', name: 'Odd', path: odd, kind: 'repo' }] }));
  const [t, o] = (await D.readProjects(wk, { home: base, now: NOW })).items;
  assert.deepEqual([t.git, t.branch, t.changed, t.last && t.last.subject], [true, 'main', 1, 'signed'], 'the status still counts the real change (the new file)');
  assert.deepEqual([o.git, o.changed], [true, null], 'a driver name -c cannot write: the status is not read');
  assert.equal(await D.git(repo, ['fetch', '-q', 'origin']), null, 'the panel uses no transport');
  assert.deepEqual(fs.readdirSync(marks), [], 'no command named by a repository ran');
  // the traps were armed: plain git, without the panel's settings, runs every one of them
  for (const [dir, ...a] of [[repo, 'status', '--porcelain'], [repo, 'log', '-1', '--format=%h'], [odd, 'status', '--porcelain'], [repo, 'fetch', '-q', 'origin']]) { try { g(dir, ...a); } catch { /* a trap may upset git; the marks tell */ } }
  assert.deepEqual(fs.readdirSync(marks).sort(), ['clean', 'ext', 'fsmonitor', 'gpg', 'included', 'odd', 'submodule']);
});

test('actions: jobs and the phone go through the plugin\'s own scripts with the exact argv and WK_HOME; a failure says why', async () => {
  const plugin = fs.mkdtempSync(path.join(base, 'plugin-')), data = path.join(base, 'wk-act');
  fs.mkdirSync(path.join(plugin, 'bin'));
  const script = "import fs from 'node:fs';import p from 'node:path';import {fileURLToPath} from 'node:url';const f=fileURLToPath(import.meta.url);"
    + "fs.appendFileSync(p.join(p.dirname(f),'calls.jsonl'),JSON.stringify({s:p.basename(f),a:process.argv.slice(2),wk:process.env.WK_HOME})+'\\n');"
    + "if(process.argv[2]==='reply'){console.error('Job is running, not waiting.');process.exit(2);}console.log(process.argv[2]==='start'?'Started J-20261116-1902-a3f9.':'Done: '+process.argv[2]+'.');\n";
  const paths = { pluginPath: plugin, dataDir: data, home: base };
  // without the scripts: a plain refusal, nothing runs
  const none = await A.jobStart(paths, { project: 'nexodyne', prompt: 'x', model: 'sonnet', mode: 'auto' });
  assert.deepEqual([none.ok, none.where, none.text], [false, 'jobs', 'the plugin has no bin/wk-job.mjs yet']);
  fs.writeFileSync(path.join(plugin, 'bin', 'wk-job.mjs'), script); fs.writeFileSync(path.join(plugin, 'bin', 'wk-bridge.mjs'), script);
  const calls = () => fs.readFileSync(path.join(plugin, 'bin', 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const r1 = await A.jobStart(paths, { project: 'nexodyne', prompt: 'Fix it\n--model opus', model: 'opus', mode: 'plan', max_turns: 20 });
  assert.deepEqual([r1.ok, r1.cleared, r1.text], [true, true, 'Started J-20261116-1902-a3f9.']);
  const r2 = await A.jobReply(paths, { job: J1, prompt: 'go on' });
  assert.deepEqual([r2.ok, r2.text, r2.extra.job], [false, 'Job is running, not waiting.', J1]);
  await A.jobStop(paths, { job: J1 });
  await A.phoneKey(paths, CRED, true); await A.phoneKey(paths, CRED, false);
  await A.phoneControl(paths, true); await A.phoneControl(paths, false);
  assert.deepEqual(calls().map(c => [c.s, c.a, c.wk]), [
    ['wk-job.mjs', ['start', '--project', 'nexodyne', '--model', 'opus', '--mode', 'plan', '--from', 'panel', '--prompt', 'Fix it\n--model opus', '--max-turns', '20'], data],
    ['wk-job.mjs', ['reply', J1, '--prompt', 'go on'], data],
    ['wk-job.mjs', ['stop', J1], data],
    ['wk-bridge.mjs', ['trust', CRED], data], ['wk-bridge.mjs', ['reject', CRED], data],
    ['wk-bridge.mjs', ['enable'], data], ['wk-bridge.mjs', ['disable'], data]]);
  // the stop switch moved out of extension.js unchanged
  fs.mkdirSync(path.join(plugin, 'config'));
  fs.writeFileSync(path.join(plugin, 'config', 'gates.json'), JSON.stringify({ kill_switch: { file: path.join(data, 'KILL') } }));
  assert.equal(A.stopSwitch(paths, true).text, 'Wake-ups stopped. The kill switch is on.');
  assert.equal(fs.existsSync(path.join(data, 'KILL')), true);
  assert.equal(A.stopSwitch(paths, false).text, 'Wake-ups are allowed again.');
  assert.equal(fs.existsSync(path.join(data, 'KILL')), false);
});

// The host: Trust and phone control on ask first in a modal; Cancel changes nothing.
test('extension: Trust and Switch on need the modal; Reject, off and the job commands go straight to the scripts', async () => {
  const w = fs.mkdtempSync(path.join(base, 'ext-')), plugin = path.join(w, 'plugin'), data = path.join(w, 'wk');
  fs.mkdirSync(path.join(plugin, 'bin'), { recursive: true }); fs.mkdirSync(data);
  fs.writeFileSync(path.join(plugin, 'bin', 'wk-ledger.mjs'), 'process.exit(3);');
  const script = "import fs from 'node:fs';import p from 'node:path';import {fileURLToPath} from 'node:url';const f=fileURLToPath(import.meta.url);"
    + "fs.appendFileSync(p.join(p.dirname(f),'calls.jsonl'),JSON.stringify([p.basename(f),...process.argv.slice(2)])+'\\n');console.log('OK '+process.argv[2]);\n";
  fs.writeFileSync(path.join(plugin, 'bin', 'wk-job.mjs'), script); fs.writeFileSync(path.join(plugin, 'bin', 'wk-bridge.mjs'), script);
  fs.writeFileSync(path.join(data, 'remote-pending.json'), JSON.stringify({ keys: [{ id: CRED2, spki: 'S', label: 'New phone', registered_at: NOW }] }));
  const cfg = { pluginPath: plugin, dataDir: data, claudeDir: path.join(w, 'claude'), orchestrationDir: '' };
  let modal = 'Cancel'; const asked = [];
  const registered = {};
  const fakeVscode = {
    Uri: { file: f => ({ fsPath: f }), joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), toString() { return 'vscode-resource:' + this.fsPath; } }) },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: k => cfg[k] }), onDidChangeConfiguration: () => ({ dispose() {} }), workspaceFolders: [] },
    window: { registerWebviewViewProvider: (id, p) => { registered[id] = p; return { dispose() {} }; }, showWarningMessage: async (...a) => { asked.push(a[0]); return modal; } },
    commands: { registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; } },
  };
  const load = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? fakeVscode : load.call(this, req, ...rest); };
  const ext = require('../extension.js');
  Module._load = load;
  ext.activate({ extensionUri: { fsPath: path.join(__dirname, '..') }, subscriptions: [] });
  const provider = registered['watchkeeper.panel'];
  const posted = [], handlers = {};
  provider.resolveWebviewView({ visible: true, webview: { cspSource: 'c', options: null, html: '', asWebviewUri: u => u, postMessage: m => { posted.push(m); return Promise.resolve(true); },
    onDidReceiveMessage: fn => { handlers.msg = fn; return { dispose() {} }; } }, onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }) });
  const calls = () => fs.existsSync(path.join(plugin, 'bin', 'calls.jsonl')) ? fs.readFileSync(path.join(plugin, 'bin', 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  const last = () => posted.filter(m => m.type === 'result').at(-1);
  try {
    const t0 = Date.now(); while (!posted.some(m => m.type === 'data')) { if (Date.now() - t0 > 3000) throw new Error('no data'); await new Promise(r => setTimeout(r, 10)); }
    const d = posted.find(m => m.type === 'data').sections;
    assert.match(d.phone, /data-cmd="trustKey"/, 'the panel renders as host antigravity');
    await handlers.msg({ cmd: 'trustKey', id: CRED2 });
    assert.deepEqual([calls(), last().text, last().where], [[], 'Nothing changed: the key is not trusted.', 'phone']);
    await handlers.msg({ cmd: 'remoteOn' });
    assert.deepEqual([calls(), last().text], [[], 'Nothing changed: phone control stays off.']);
    assert.equal(asked.length, 2);
    modal = 'Trust'; await handlers.msg({ cmd: 'trustKey', id: CRED2 });
    modal = 'Switch on'; await handlers.msg({ cmd: 'remoteOn' });
    await handlers.msg({ cmd: 'trustKey', id: CRED });
    assert.deepEqual([last().ok, last().text], [false, 'That phone key is not waiting any more.']);
    await handlers.msg({ cmd: 'rejectKey', id: CRED2 }); await handlers.msg({ cmd: 'remoteOff' });
    await handlers.msg({ cmd: 'jobStart', project: 'nexodyne', prompt: 'Fix', model: 'haiku', mode: 'acceptEdits' });
    await handlers.msg({ cmd: 'jobReply', job: J1, prompt: 'yes' }); await handlers.msg({ cmd: 'jobStop', job: J1 });
    await handlers.msg({ cmd: 'jobStart', project: 'nexodyne', prompt: 'Fix', mode: 'bypassPermissions' });
    assert.deepEqual([last().ok, last().where], [false, 'jobs']);
    assert.deepEqual(calls(), [['wk-bridge.mjs', 'trust', CRED2], ['wk-bridge.mjs', 'enable'], ['wk-bridge.mjs', 'reject', CRED2], ['wk-bridge.mjs', 'disable'],
      ['wk-job.mjs', 'start', '--project', 'nexodyne', '--model', 'haiku', '--mode', 'acceptEdits', '--from', 'panel', '--prompt', 'Fix'],
      ['wk-job.mjs', 'reply', J1, '--prompt', 'yes'], ['wk-job.mjs', 'stop', J1]]);
  } finally { if (provider.stop) provider.stop(); }
});

test('a legal job: the reader keeps legal and the model id; both hosts show "Legal: newest top model (<id>)" with the hooks intact', () => {
  const wk = fs.mkdtempSync(path.join(base, 'wk-legal-'));
  const mk = (id, meta) => { fs.mkdirSync(path.join(wk, 'jobs', id), { recursive: true });
    fs.writeFileSync(path.join(wk, 'jobs', id, 'meta.json'), JSON.stringify({ id, project: 'nexodyne', model: 'sonnet', mode: 'auto', from: 'phone', state: 'waiting', started_at: NOW, ...meta }));
    fs.writeFileSync(path.join(wk, 'jobs', id, 'prompt-1.txt'), 'Update the privacy policy'); fs.writeFileSync(path.join(wk, 'jobs', id, 'events.jsonl'), ''); };
  mk(J1, { legal: true, model_id: 'claude-fable-5-2' });
  mk(J2, { legal: true, model_id: '<b>x</b>' });
  mk(J3, { legal: 'yes', model_id: 'claude-fable-5-2' });
  const js = D.readJobs(wk), by = id => js.find(j => j.id === id);
  assert.deepEqual([by(J1).legal, by(J1).model_id], [true, 'claude-fable-5-2']);
  assert.equal(by(J2).model_id, '', 'a model id that is not an id is dropped');
  assert.ok(!('legal' in by(J3)), 'only legal: true counts');
  assert.equal(D.legalLabel('claude-fable-5-2'), 'Legal: newest top model (claude-fable-5-2)');
  assert.equal(D.isLegal('Rewrite the terms of service'), 'terms of service');
  for (const host of ['antigravity', 'web']) {
    const h = R.renderJobs({ ...model(), host, jobs: js });
    assert.match(h, new RegExp(`data-job-item="${J1}"[\\s\\S]*?Legal: newest top model \\(claude-fable-5-2\\)`), host);
    assert.match(h, new RegExp(`data-job-item="${J2}"[\\s\\S]*?Legal: newest top model[^(]`), host);
    assert.match(h, new RegExp(`data-reply="${J1}"[\\s\\S]*data-cmd="jobReply" data-job="${J1}"`));
    for (const id of ['job-project', 'job-prompt', 'job-model', 'job-mode', 'job-turns']) assert.match(h, new RegExp(`id="${id}"`));
    assert.doesNotMatch(h, /<b>x<\/b>/);
  }
});

test('escaping (review fix W2, item 9): ids in data attributes, the model and mode options, question numbers and suggestion ids', () => {
  const hostileIds = model({
    jobs: [{ id: HOSTILE, project: 'p', model: 'sonnet', mode: 'auto', from: 'phone', state: 'waiting', started_at: NOW, title: 't', last_text: '', tail: [] }],
    questions: { available: true, items: [{ n: HOSTILE, from: HOSTILE, date: HOSTILE, text: HOSTILE, rec: HOSTILE, money: true, h: HOSTILE }], total: 1, hidden: 0 },
    suggestions: { items: [{ id: HOSTILE, title: HOSTILE, detail: HOSTILE, action: 'none', from: HOSTILE, at: NOW, money: true }], total: 1 },
  });
  D.MODELS.push(HOSTILE); D.MODES.push(HOSTILE);
  try {
    for (const host of ['antigravity', 'web']) {
      const h = R.renderJobs({ ...hostileIds, host }) + R.renderWaiting({ ...hostileIds, host });
      assert.doesNotMatch(h, /<img/, host);
      assert.doesNotMatch(h, /"'`&(?!amp;|lt;|gt;|quot;|#)/, `${host}: raw quotes`);
      assert.match(h, /<option value="&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&#96;&amp;">/);
    }
  } finally { D.MODELS.pop(); D.MODES.pop(); }
  assert.equal(R.renderStatus({ ...model(), pace: { state: 'no-meter' } }).includes('<img'), false);
});
