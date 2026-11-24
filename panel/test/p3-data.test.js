'use strict';
// P2-272 Phase 3 stage B: the usage card, the account line, the prompt badges, the archive (moves, never deletes) and N4.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../src/data.js');
const R = require('../src/render.js');
const C = require('../src/chat-sessions.js');
const CH = require('../src/channel.js');

const EVIL = '<img src=x onerror="window.__xss=1">Fix the "quotes" & <b>tags</b>';
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), `wk-p3b-${p}-`));
const noRawEvil = (html, where) => {
  assert.doesNotMatch(html, /<img src=x/, `${where}: no live <img>`);
  assert.doesNotMatch(html, /<b>tags<\/b>/, `${where}: no live <b>`);
};
const writeMeter = (dir, obj) => { fs.mkdirSync(path.join(dir, 'steward'), { recursive: true }); fs.writeFileSync(path.join(dir, 'steward', 'meter.json'), JSON.stringify(obj)); };

// ---------------------------------------------------------------- the usage card (spec 3.4)
test('resetLine and the 5-hour line use the 24-hour International style in local time', () => {
  const at = new Date(2026, 10, 30, 18, 46).getTime();   // Monday 30 November 2026, local
  assert.equal(R.resetLine(at), 'Resets Mon 30 Nov at 18:46');
  assert.equal(R.resetLine(new Date(2026, 0, 3, 6, 5).getTime()), 'Resets Sat 3 Jan at 06:05');
  const html = R.renderUsage({ now: at - 3600e3, usage: { found: true, fetchedAt: at - 3600e3, windows: { five_hour: { pct: 42, resetsAt: at } } } });
  assert.match(html, /5-hour window: 42% · Resets at 18:46/);
});

test('readUsageWindows: present, missing, expired, old-style and hostile windows', () => {
  const dir = tmp('meter'), now = Date.now(), s = ms => Math.round(ms / 1000);
  assert.deepEqual(D.readUsageWindows(dir, now), { found: false, fetchedAt: 0, windows: {} }, 'no meter file');
  writeMeter(dir, { fetchedAt: new Date(now - 60e3).toISOString(), windows: {
    seven_day: { utilization: 0.38, resetsAt: s(now + 5 * 86400e3) },
    seven_day_opus: { utilization: 12, resetsAt: s(now + 5 * 86400e3) },        // already a percentage
    seven_day_sonnet: { utilization: 0.9, resetsAt: s(now - 60e3) },             // reset since the reading
    five_hour: { utilization: 0.42, resetsAt: s(now + 2 * 3600e3) },
    'evil<b>': { utilization: 0.5, resetsAt: s(now + 3600e3) },                   // not a window name
    seven_day_fable: { utilization: 'x', resetsAt: s(now + 3600e3) },             // not a number
  } });
  const u = D.readUsageWindows(dir, now);
  assert.equal(u.found, true); assert.ok(u.fetchedAt > 0);
  assert.deepEqual(Object.keys(u.windows).sort(), ['five_hour', 'seven_day', 'seven_day_opus']);
  assert.equal(u.windows.seven_day.pct, 38); assert.equal(u.windows.seven_day_opus.pct, 12); assert.equal(u.windows.five_hour.pct, 42);
  assert.equal(u.windows.seven_day.resetsAt, s(now + 5 * 86400e3) * 1000, 'seconds become milliseconds');
  // an older meter without `windows`: the top-level reading is the weekly one
  const old = tmp('meter-old');
  writeMeter(old, { fetchedAt: new Date(now).toISOString(), utilization: 0.5, resetsAt: s(now + 86400e3), fiveHour: { utilization: 0.1, resetsAt: s(now + 3600e3) } });
  const o = D.readUsageWindows(old, now);
  assert.equal(o.windows.seven_day.pct, 50); assert.equal(o.windows.five_hour.pct, 10);
  // a broken file is "not found", never a throw
  const bad = tmp('meter-bad'); fs.mkdirSync(path.join(bad, 'steward')); fs.writeFileSync(path.join(bad, 'steward', 'meter.json'), '{nope');
  assert.equal(D.readUsageWindows(bad, now).found, false);
});

test('renderUsage: missing windows say "no reading yet"; no 5-hour line without a reading; no meter says so', () => {
  const now = Date.now();
  const one = R.renderUsage({ now, usage: { found: true, fetchedAt: now - 13 * 60e3, windows: { seven_day: { pct: 38, resetsAt: now + 86400e3 } } }, account: { state: 'ok', email: 'owner@example.test' } });
  assert.match(one, /Weekly \(7 day\)<\/span><span class="usage-v">38%/);
  for (const l of ['Fable limit', 'Opus limit', 'Sonnet limit']) assert.match(one, new RegExp(`${l}</span><span class="usage-v">no reading yet`), l);
  assert.doesNotMatch(one, /5-hour window/, 'no five-hour reading, no five-hour line');
  assert.match(one, /Read 13 min ago\./);
  assert.match(one, /Email:<\/span> <span class="usage-v">owner@example\.test/);
  const none = R.renderUsage({ now, usage: { found: false, fetchedAt: 0, windows: {} } });
  // P2-272 P3 fixes (M3): no weekly Gemini figure exists, so the Gemini weekly line is gone; the four Claude lines stay
  assert.equal((none.match(/no reading yet/g) || []).length, 4, 'four Claude lines; no Gemini weekly line');
  assert.match(none, /Nothing counted yet\./); assert.doesNotMatch(none, /Ready/);
  assert.match(none, /No meter reading yet\./);
  assert.match(none, /Email:<\/span> <span class="usage-v usage-missing">Not known yet/);
  for (const [state, words] of [['signed-out', 'Not signed in'], ['error', 'Could not be read'], ['stopped', 'Not read: the Stop switch is on'], ['off', 'Not read']]) {
    assert.match(R.renderUsage({ now, account: { state, email: 'leak@example.test' } }), new RegExp(words), state);
    assert.doesNotMatch(R.renderUsage({ now, account: { state, email: 'leak@example.test' } }), /leak@example/, `${state}: an email only with state ok`);
  }
  // a percentage that is not a number never breaks the meter element
  assert.match(R.renderUsage({ now, usage: { found: true, windows: { seven_day: { pct: 'x', resetsAt: now + 1e6 } } } }), /value="0"/);
});

test('the Gemini block: label rules, Watchkeeper-tracked weekly line, today and Carbon High', () => {
  assert.equal(R.geminiLabelOf({}), 'Gemini / Antigravity');
  assert.equal(R.geminiLabelOf({ label: '   ' }), 'Gemini / Antigravity');
  assert.equal(R.geminiLabelOf({ label: ' Work Gemini ' }), 'Work Gemini');
  assert.equal(R.geminiLabelOf(null), 'Gemini / Antigravity');
  const now = Date.now();
  const ready = R.renderUsage({ now, geminiUsage: { label: '', today: { requests: 12, spendUsd: 0.34 }, cooldownUntil: 0 } });
  // P2-272 P3 fixes (M3): one honest hint, no weekly %, no "Ready"; the cooldown row says what is on record
  assert.match(ready, /Gemini \/ Antigravity/); assert.match(ready, /Watchkeeper's own count on this Mac, not Google's figure\./);
  const gem = ready.slice(ready.indexOf('Gemini / Antigravity'));
  assert.doesNotMatch(gem, /Weekly|%/); assert.doesNotMatch(gem, /Ready/);
  assert.match(ready, /12 requests · US\$0\.34/); assert.match(ready, /Cooldown<\/span><span class="usage-v">No cooldown on record/);
  const at = new Date(2026, 10, 30, 1, 46).getTime();
  assert.match(R.renderUsage({ now: at - 3600e3, geminiUsage: { tracked: true, cooldownUntil: at } }), /Cooldown until 01:46/);
  assert.match(R.renderUsage({ now: at + 1, geminiUsage: { tracked: true, cooldownUntil: at } }), /usage-v">No cooldown on record/, 'a past cooldown is no cooldown');
  assert.doesNotMatch(R.renderUsage({ now, geminiUsage: {} }), /Today/, 'no count today, no Today line');
});

test('readGeminiUsage: the owner\'s label only, never Antigravity\'s login files; today from Watchkeeper\'s own count', () => {
  const home = tmp('gem-home'), now = Date.now();
  // a login file Antigravity might keep, with an address in it: never read for the label
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'login@example.test' }));
  fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ email: 'login@example.test' }));
  const wk = path.join(home, '.gemini', 'antigravity', 'plugin_data', 'watchkeeper'); fs.mkdirSync(wk, { recursive: true });
  const env = { HOME: home };
  assert.deepEqual(D.readGeminiUsage(home, { now, env }), { label: '', tracked: false, today: null, cooldownUntil: 0, cooldownReason: '', weekTasks: null }); // P2-272 P3 fixes (M3): weekTasks, null without a tasks folder
  fs.writeFileSync(path.join(wk, 'orchestrator_usage.json'), JSON.stringify({ date: new Date(now).toISOString().slice(0, 10),
    providers: { gemini: { requests: 12, spend_usd: 0.34, cooldown_until: (now + 7200e3) / 1000, cooldown_reason: 'rate limit\nsecond line' } } }));
  const g = D.readGeminiUsage(home, { now, env });
  assert.equal(g.label, ''); assert.equal(g.tracked, true);
  assert.deepEqual(g.today, { requests: 12, spendUsd: 0.34 });
  assert.ok(g.cooldownUntil > now); assert.doesNotMatch(g.cooldownReason, /\n/);
  assert.doesNotMatch(JSON.stringify(g), /login@example/, 'nothing from the login files');
  assert.equal(R.geminiLabelOf(g), 'Gemini / Antigravity');
  assert.equal(D.readGeminiUsage(home, { now, env, label: 'Mine\n<b>x</b>' }).label.includes('\n'), false, 'the label is one line');
  // yesterday's count is not today's
  fs.writeFileSync(path.join(wk, 'orchestrator_usage.json'), JSON.stringify({ date: '2000-01-01', providers: { gemini: { requests: 9 } } }));
  assert.equal(D.readGeminiUsage(home, { now, env }).today, null);
});

// ---------------------------------------------------------------- the account email (stub `claude` on a temp PATH and HOME)
function stubClaude(body) {
  const bin = tmp('bin'), home = tmp('home');
  const marker = path.join(home, 'ran');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n: > "${marker}"\n[ "$1 $2 $3" = "auth status --json" ] || exit 3\n${body}\n`, { mode: 0o755 });
  return { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, marker };
}
test('readClaudeAccount: email only from `claude auth status --json`; signed out, bad output, timeout and Stop switch', async () => {
  const ok = stubClaude(`printf '%s' '{"loggedIn":true,"email":"owner@example.test","orgName":"x"}'`);
  const a = await D.readClaudeAccount({ env: ok.env, now: 1 });
  assert.deepEqual(Object.keys(a).sort(), ['email', 'state']); assert.equal(a.state, 'ok'); assert.equal(a.email, 'owner@example.test');
  fs.rmSync(ok.marker);
  const cached = await D.readClaudeAccount({ env: ok.env, now: 2 });
  assert.equal(cached.state, 'ok'); assert.equal(fs.existsSync(ok.marker), false, 'the cached answer runs nothing');
  const out = stubClaude(`printf '%s' '{"loggedIn":false,"email":"old@example.test"}'`);
  assert.deepEqual(await D.readClaudeAccount({ env: out.env }), { state: 'signed-out', email: '' });
  const junk = stubClaude(`printf 'not json'`);
  assert.deepEqual(await D.readClaudeAccount({ env: junk.env }), { state: 'error', email: '' });
  const noMail = stubClaude(`printf '%s' '{"loggedIn":true,"email":"<b>not an email"}'`);
  assert.deepEqual(await D.readClaudeAccount({ env: noMail.env }), { state: 'unknown', email: '' });
  const slow = stubClaude('sleep 20');
  const t0 = Date.now();
  assert.deepEqual(await D.readClaudeAccount({ env: slow.env, timeoutMs: 300 }), { state: 'error', email: '' });
  assert.ok(Date.now() - t0 < 5000, 'the timeout ends the child');
  const stop = stubClaude(`printf '%s' '{"email":"owner@example.test"}'`);
  assert.deepEqual(await D.readClaudeAccount({ env: stop.env, killOn: true }), { state: 'stopped', email: '' });
  assert.equal(fs.existsSync(stop.marker), false, 'the Stop switch runs nothing');
  const missing = { HOME: tmp('home'), PATH: tmp('empty-bin') };
  assert.deepEqual(await D.readClaudeAccount({ env: missing }), { state: 'error', email: '' });
});

test('collect: the account is read only when asked (stub on a temp PATH); otherwise "off"', async () => {
  const home = tmp('collect-home');
  const off = await D.collect({}, Date.now(), { home });
  assert.equal(off.account.state, 'no-plugin', 'without the plugin (lite mode) nothing is read');
  assert.equal(off.account.email, '');
  const st = stubClaude(`printf '%s' '{"loggedIn":true,"email":"owner@example.test"}'`);
  const asked = await D.collect({}, Date.now(), { home, account: true, accountEnv: st.env });
  assert.equal(asked.account.email, ''); assert.equal(fs.existsSync(st.marker), false, 'lite mode runs no claude child');
  assert.ok(off.usage && typeof off.usage.windows === 'object'); assert.ok(off.geminiUsage);
});

test('the phone page (host web) never gets the usage card or the email', async () => {
  const now = Date.now();
  const base = await D.collect({}, now, { home: tmp('web-home') });
  const m = { ...base, now, pace: { state: 'ok', pace: { decision: 'run' } }, account: { state: 'ok', email: 'owner@example.test' },
    usage: { found: true, fetchedAt: now, windows: { seven_day: { pct: 38, resetsAt: now + 1e6 } } }, geminiUsage: {} };
  const web = R.renderSections({ ...m, host: 'web' }), local = R.renderSections({ ...m, host: 'antigravity' });
  assert.equal(web.usage, '');
  assert.doesNotMatch(JSON.stringify(web), /owner@example\.test/);
  assert.match(local.usage, /owner@example\.test/);
});

test('escaping: hostile email, label and reason never become markup', () => {
  const now = Date.now();
  const html = R.renderUsage({ now, account: { state: 'ok', email: EVIL }, geminiUsage: { label: EVIL, today: { requests: 1, spendUsd: 0 } },
    usage: { found: true, fetchedAt: now, windows: { seven_day: { pct: EVIL, resetsAt: now + 1e6 } } } });
  noRawEvil(html, 'usage card');
  assert.match(html, /&lt;img src=x/);
});

// ---------------------------------------------------------------- badges (spec 3.5)
test('promptModeOf goes through the one prefix grammar; badges are inline SVG with no "local" word', () => {
  assert.equal(C.promptModeOf('raw: fix the bug'), 'raw');
  assert.equal(C.promptModeOf(':raw fix the bug'), 'raw');
  assert.equal(C.promptModeOf('/wk raw: fix'), 'raw');
  // P2-273 (owner, 24 Nov): a plain prompt is re-prompted only above 30 words; rp: always; raw: never.
  const w31 = Array(31).fill('fix').join(' '), w30 = Array(30).fill('fix').join(' ');
  assert.equal(C.promptModeOf('fix the bug'), 'raw');
  assert.equal(C.promptModeOf(w30), 'raw');
  assert.equal(C.promptModeOf(w31), 'reprompt');
  assert.equal(C.promptModeOf(w31, { autoReprompt: false }), 'raw');
  assert.equal(C.promptModeOf(w31, { overWords: 0 }), 'raw');
  assert.equal(C.promptModeOf('rp: fix the bug', { autoReprompt: false }), 'reprompt');
  assert.equal(C.promptModeOf('raw: ' + w31), 'raw');
  for (const mode of ['raw', 'reprompt', undefined, EVIL]) {
    const b = R.promptBadge(mode);
    assert.match(b, /^<span class="prompt-badge prompt-badge-(raw|reprompt)"/); assert.match(b, /<svg class="shape icon-(raw|reprompt)"[^>]*aria-hidden="true"/);
    assert.doesNotMatch(b, /local/i); noRawEvil(b, 'badge');
  }
  assert.match(R.promptBadge('raw'), /:raw<\/span>$/); assert.match(R.promptBadge('other'), /:re-prompt<\/span>$/);
});

test('createChatSession stores promptMode; the rail shows the badge', () => {
  const dir = tmp('sess');
  const raw = C.createChatSession(dir, { title: 'a', promptMode: 'raw' });
  const rp = C.createChatSession(dir, { title: EVIL, promptMode: 'reprompt' });
  const stored = C.loadChatSessions(dir);
  assert.equal(stored.find(s => s.id === raw.id).promptMode, 'raw'); assert.equal(stored.find(s => s.id === rp.id).promptMode, 'reprompt');
  const rail = R.renderRail({ now: Date.now(), chatSessions: C.listChatSessionSummaries(dir), sessions: { sessions: [] } });
  const html = typeof rail === 'string' ? rail : JSON.stringify(rail);
  assert.match(html, /prompt-badge-raw/); assert.match(html, /prompt-badge-reprompt/); noRawEvil(typeof rail === 'string' ? rail : Object.values(rail).join(''), 'rail');
});

// ---------------------------------------------------------------- the re-prompted pill (spec 3.2)
test('the bubble shows only the raw prompt; the pill opens a read-only drawer with compiled prompt, graph nodes, time and skills', () => {
  const t = { id: 'T-abc123def', rawPrompt: EVIL, repromptedText: 'Compiled: ' + EVIL, repromptMs: 2400, status: 'done', promptMode: 'reprompt',
    graphify: { available: true, matchedNodes: 14, totalNodes: 812, topFiles: [EVIL, 'a.js'] }, skills: [{ name: EVIL }, { name: 'wk-take-task' }] };
  const d = R.repromptDrawer(t, t.graphify, t.skills);
  assert.match(d, /<details class="rp-drawer"><summary class="rp-pill">/); assert.match(d, /re-prompted<\/summary>/);
  assert.match(d, /Compiled prompt \(read-only\)/); assert.match(d, /Graph nodes<\/dt><dd>14 of 812/); assert.match(d, /2\.4 s/); assert.match(d, /wk-take-task/);
  assert.doesNotMatch(d, /<textarea|contenteditable|<input/, 'read-only'); noRawEvil(d, 'drawer');
  assert.equal(R.repromptDrawer({ ...t, promptMode: 'raw' }, t.graphify, t.skills), '', 'raw turns have no pill');
  assert.equal(R.repromptDrawer({ ...t, repromptedText: '' }, t.graphify, t.skills), '', 'nothing compiled, no pill');
  assert.match(R.repromptDrawer({ ...t, repromptMs: undefined, graphify: {} }, {}, []), /no graph used[\s\S]*not recorded[\s\S]*none/);
  // the thread: the compiled text appears only inside the drawer, never in the bubble's own <pre>
  const thread = R.renderChatThread({ activeSession: { id: 'WKS-20261123-120000-abcd', title: 'x', promptMode: 'reprompt', turns: [t] } });
  const bubble = /<div class="chat-bubble chat-user">[\s\S]*?<pre class="chat-pre">([\s\S]*?)<\/pre>/.exec(thread);
  assert.ok(bubble); assert.doesNotMatch(bubble[1], /Compiled:/); noRawEvil(thread, 'thread');
});

// ---------------------------------------------------------------- auto-archive (spec 3.6)
const listFiles = dir => { const out = []; const walk = d => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); fs.statSync(f).isDirectory() ? walk(f) : out.push(path.relative(dir, f)); } }; walk(dir); return out.sort(); };

test('archiveChatSession moves to chat-sessions/archive/<id>.json; reopen brings it back and keeps the file', () => {
  const dir = tmp('arch'), now = Date.now();
  const s = C.createChatSession(dir, { title: EVIL, promptMode: 'raw', now });
  C.upsertTurn(dir, s.id, { id: 'T-abc123def', rawPrompt: 'hi', status: 'done' }, now);
  const before = C.getChatSession(dir, s.id);
  const rec = C.archiveChatSession(dir, s.id, 'done', now + 1);
  assert.equal(rec.archiveReason, 'done'); assert.equal(C.getChatSession(dir, s.id), null, 'out of the active list');
  const file = path.join(C.archiveDir(dir), `${s.id}.json`);
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(kept.turns, before.turns, 'every turn kept'); assert.equal(kept.promptMode, 'raw');
  const listed = C.listArchivedChatSessions(dir);
  assert.equal(listed.length, 1); assert.equal(listed[0].id, s.id); assert.equal(listed[0].promptMode, 'raw');
  // the archived list in the rail: escaped, with Reopen
  const rail = R.renderRail({ now, chatSessions: [], archivedChatSessions: listed, sessions: { sessions: [] } });
  const railHtml = typeof rail === 'string' ? rail : Object.values(rail).join('');
  assert.match(railHtml, /Archived \(1\)/); assert.match(railHtml, new RegExp(`data-cmd="chatReopen" data-session-id="${s.id}"`)); noRawEvil(railHtml, 'archived rail');
  // reopen
  const back = C.reopenChatSession(dir, s.id, now + 2);
  assert.equal(back.id, s.id); assert.ok(C.getChatSession(dir, s.id)); assert.deepEqual(C.getChatSession(dir, s.id).turns, before.turns);
  assert.equal(fs.existsSync(file), false); assert.ok(fs.existsSync(path.join(C.archiveDir(dir), `${s.id}.reopened-${now + 2}.json`)), 'the archive file is renamed, never deleted');
  assert.equal(C.listArchivedChatSessions(dir).length, 0);
  // bad ids do nothing
  assert.equal(C.archiveChatSession(dir, '../x', 'done'), null); assert.equal(C.reopenChatSession(dir, '../x'), null);
  assert.equal(C.archiveChatSession(dir, 'WKS-20000101-000000-ffff', 'done'), null);
});

test('autoArchiveCandidates: the three triggers, nothing open or waiting, and a reopened session stays', () => {
  const id = n => `WKS-20261123-12000${n}-abcd`;
  const sessions = [
    { id: id(1), taskId: 'T-1', turns: [{ status: 'done' }] },                                          // task done
    { id: id(2), taskId: 'T-2', turns: [{ status: 'done' }, { status: 'awaiting_confirm' }] },          // waiting
    { id: id(3), claudeSessionId: 'c-3', turns: [{ status: 'done' }] },                                // Claude finished
    { id: id(4), claudeSessionId: 'c-4', turns: [{ status: 'done' }] },                                // Claude still going
    { id: id(5), taskId: 'T-5', turns: [{ status: 'done' }] },                                          // open now
    { id: id(6), taskId: 'T-6', turns: [{ status: 'done' }], reopenedAt: 100, updatedAt: 100 },         // reopened, no new turn
    { id: id(7), taskId: 'T-7', turns: [{ status: 'done' }], reopenedAt: 100, updatedAt: 200 },         // reopened, then a new turn
    { id: id(8), turns: [{ status: 'done' }] },                                                         // plain chat: only Done archives it
    { id: '../evil', taskId: 'T-9', turns: [{ status: 'done' }] },
  ];
  const got = C.autoArchiveCandidates(sessions, { activeId: id(5), finishedClaudeIds: ['c-3'] });
  assert.deepEqual(got, [{ id: id(1), reason: 'task-done' }, { id: id(3), reason: 'claude-finished' }, { id: id(7), reason: 'task-done' }]);
  assert.deepEqual(C.autoArchiveCandidates(null), []);
});

test('archiveStaleHookSessions moves old, closed files to archive/ and deletes nothing', () => {
  const dir = tmp('hooks'), now = Date.now(), old = (now - 8 * 86400e3) / 1000;
  for (const n of ['old.json', 'open.json', 'new.json']) fs.writeFileSync(path.join(dir, n), n);
  for (const n of ['old.json', 'open.json']) fs.utimesSync(path.join(dir, n), old, old);
  fs.mkdirSync(path.join(dir, 'archive')); fs.writeFileSync(path.join(dir, 'archive', 'old.json'), 'earlier');
  const before = listFiles(dir).length;
  const moved = C.archiveStaleHookSessions(dir, { now, openIds: ['open'] });
  assert.deepEqual(moved, ['old.json']);
  const after = listFiles(dir);
  assert.equal(after.length, before, 'same number of files: moved, not deleted');
  assert.ok(after.includes('open.json')); assert.ok(after.includes('new.json')); assert.ok(!after.includes('old.json'));
  assert.equal(fs.readFileSync(path.join(dir, 'archive', 'old.json'), 'utf8'), 'earlier', 'an earlier archive file is never overwritten');
  assert.ok(after.some(f => /^archive\/old\.\d+\.json$/.test(f)));
});

test('chatDone and chatReopen: only real session ids pass the whitelist', () => {
  const good = 'WKS-20261123-120000-abcd';
  assert.deepEqual(D.validateMessage({ cmd: 'chatDone' }), { ok: true, msg: { cmd: 'chatDone' } });
  assert.deepEqual(D.validateMessage({ cmd: 'chatDone', sessionId: good }), { ok: true, msg: { cmd: 'chatDone', sessionId: good } });
  assert.deepEqual(D.validateMessage({ cmd: 'chatReopen', sessionId: good }), { ok: true, msg: { cmd: 'chatReopen', sessionId: good } });
  for (const bad of ['../x', EVIL, 'WKS-1', 42, {}]) {
    assert.equal(D.validateMessage({ cmd: 'chatDone', sessionId: bad }).ok, false, `chatDone ${String(bad)}`);
    assert.equal(D.validateMessage({ cmd: 'chatReopen', sessionId: bad }).ok, false, `chatReopen ${String(bad)}`);
  }
  assert.equal(D.validateMessage({ cmd: 'chatReopen' }).ok, false, 'Reopen needs an id');
  const extra = D.validateMessage({ cmd: 'chatDone', sessionId: good, path: '/etc' });
  assert.deepEqual(extra.msg, { cmd: 'chatDone', sessionId: good }, 'extra fields are dropped');
});

// ---------------------------------------------------------------- N4: public_tree in update.json
test('N4: parseUpdate accepts a SHA-1 or SHA-256 public_tree and refuses any other', () => {
  const base = { schema: 1, type: 'update', product: 'watchkeeper', version: '0.9.0', tag: 'v0.9.0', commit: 'a'.repeat(40), released_at: '2026-11-23', notes: 'x' };
  const p = o => CH.parseUpdate(Buffer.from(JSON.stringify({ ...base, ...o })));
  assert.equal('public_tree' in p({}), false, 'optional: absent stays absent');
  assert.equal(p({ public_tree: 'b'.repeat(40) }).public_tree, 'b'.repeat(40));
  assert.equal(p({ public_tree: 'c'.repeat(64) }).public_tree, 'c'.repeat(64));
  for (const bad of ['B'.repeat(40), 'b'.repeat(39), 'b'.repeat(41), 'b'.repeat(63), 'g'.repeat(40), '', null, 42, ['b'.repeat(40)], 'b'.repeat(40) + '\n']) {
    assert.throws(() => p({ public_tree: bad }), /public_tree/, `refuses ${JSON.stringify(bad)}`);
  }
});
