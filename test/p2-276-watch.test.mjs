// P2-276: the 30-second checker (bin/wk-watch.mjs) and the heartbeat the guard hooks write.
// Everything runs in a temporary HOME and WK_HOME; launchctl and systemctl are stubs; agy, claude, gemini, osascript
// and notify-send on PATH are fakes that only write a marker. The agent markers must never appear.
import nodeTest from "node:test";
// P2-282: these tests run sh stubs (launchctl, systemctl, sh -c); on Windows each one is skipped with the reason.
const UNIX_ONLY = process.platform === "win32" && "needs sh stub scripts (launchctl, systemctl, sh -c), which Windows does not run";
const test = UNIX_ONLY ? (name, o, f) => nodeTest(name, { ...(typeof o === "object" && o ? o : {}), skip: UNIX_ONLY }, typeof o === "function" ? o : f) : nodeTest;
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { earlierWorkLines } from '../bin/lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = path.join(root, 'bin', 'wk-watch.mjs');
const AGENTS = ['agy', 'claude', 'gemini'];

function sandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2-276-')));
  const s = { base, home: path.join(base, 'home'), wk: path.join(base, 'home', '.wk'), bin: path.join(base, 'fakebin'), marks: path.join(base, 'marks') };
  for (const d of [s.home, s.wk, s.bin, s.marks]) fs.mkdirSync(d, { recursive: true });
  for (const name of [...AGENTS, 'osascript', 'notify-send', 'launchctl', 'systemctl']) {
    const f = path.join(s.bin, name);
    fs.writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(s.marks, name)}'\nexit 0\n`, { mode: 0o755 });
  }
  s.env = (extra = {}) => ({ PATH: `${s.bin}:/usr/bin:/bin`, HOME: s.home, WK_HOME: s.wk, TMPDIR: os.tmpdir(), WK_WATCH_PLATFORM: 'darwin',
    WK_LAUNCH_AGENTS: path.join(s.home, 'Library', 'LaunchAgents'), WK_LAUNCHCTL: path.join(s.bin, 'launchctl'), WK_LAUNCHCTL_PAUSE_MS: '0', WK_OSASCRIPT: path.join(s.bin, 'osascript'), ...extra });
  s.mark = name => { try { return fs.readFileSync(path.join(s.marks, name), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  s.noAgents = () => { for (const a of AGENTS) assert.deepEqual(s.mark(a), [], `${a} must never be started`); };
  s.run = (args, extra = {}, input) => spawnSync(process.execPath, [WATCH, ...args], { env: s.env(extra), encoding: 'utf8', input, timeout: 60000 });
  s.task = (id, meta = {}) => {
    const d = path.join(s.wk, 'tasks', id); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, status: 'queued', title: `title of ${id}`, ...meta }));
    return d;
  };
  s.handoffs = ws => fs.writeFileSync(path.join(s.wk, 'shared-workspace.json'), JSON.stringify({ workspaces: ws }));
  return s;
}
const json = r => { assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout.trim().split('\n').pop()); };

// ---------------------------------------------------------------- heartbeat from each guard hook
function worktreeTask(s, id) {
  const wt = path.join(s.wk, 'worktrees', id); fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  s.task(id, { status: 'taken' });
  return { wt, hb: path.join(s.wk, 'tasks', id, 'heartbeat') };
}

test('the Claude Code guard touches the task heartbeat for a call inside its worktree', () => {
  const s = sandbox(), id = '20261124-190000-hb-claude';
  const { wt, hb } = worktreeTask(s, id);
  const ev = { tool_name: 'Read', tool_input: { file_path: path.join(wt, 'src', 'a.js') }, cwd: s.base };
  spawnSync(process.execPath, [path.join(root, 'bin', 'wk-guard.mjs')], { env: s.env({ CLAUDE_PROJECT_DIR: '' }), input: JSON.stringify(ev), encoding: 'utf8', timeout: 30000 });
  assert.ok(fs.existsSync(hb), 'heartbeat written');
  assert.ok(Date.now() - fs.statSync(hb).mtimeMs < 60000, 'heartbeat is fresh');
  assert.equal(fs.statSync(hb).mode & 0o777, 0o600);
  s.noAgents();
});

test('the Antigravity guard touches the task heartbeat when the cwd is the worktree', () => {
  const s = sandbox(), id = '20261124-190001-hb-agy';
  const { wt, hb } = worktreeTask(s, id);
  fs.writeFileSync(hb, ''); const old = new Date(Date.now() - 3600_000); fs.utimesSync(hb, old, old);
  const ev = { toolCall: { name: 'view_file', args: { AbsolutePath: path.join(wt, 'src', 'a.js') } }, cwd: wt, conversationId: 'c1' };
  spawnSync(process.execPath, [path.join(root, 'bin', 'wk-guard-agy.mjs')], { env: s.env({ CLAUDE_PROJECT_DIR: '' }), input: JSON.stringify(ev), encoding: 'utf8', timeout: 30000 });
  assert.ok(Date.now() - fs.statSync(hb).mtimeMs < 60000, 'old heartbeat refreshed');
  s.noAgents();
});

test('the guard writes no heartbeat outside a worktree and never follows a symlinked heartbeat', () => {
  const s = sandbox(), id = '20261124-190002-hb-link';
  const { wt, hb } = worktreeTask(s, id);
  const outside = path.join(s.base, 'elsewhere.txt'); fs.writeFileSync(outside, 'x');
  const old = new Date(Date.now() - 3600_000); fs.utimesSync(outside, old, old);
  const guard = ev => spawnSync(process.execPath, [path.join(root, 'bin', 'wk-guard.mjs')], { env: s.env({ CLAUDE_PROJECT_DIR: '' }), input: JSON.stringify(ev), encoding: 'utf8', timeout: 30000 });
  guard({ tool_name: 'Read', tool_input: { file_path: outside }, cwd: s.base });
  assert.ok(!fs.existsSync(hb), 'no heartbeat for a call outside the worktree');
  fs.symlinkSync(outside, hb);
  guard({ tool_name: 'Read', tool_input: { file_path: path.join(wt, 'src', 'a.js') }, cwd: wt });
  assert.ok(fs.lstatSync(hb).isSymbolicLink(), 'the link is left alone');
  assert.ok(Math.abs(fs.statSync(outside).mtimeMs - old.getTime()) < 2000, 'its target is not touched');
});

test('earlierWorkLines names the backup and the earlier diff of a requeued task', () => {
  const s = sandbox(), id = '20261124-190003-earlier';
  assert.deepEqual(earlierWorkLines({ id }, s.wk), [], 'nothing earlier, nothing said');
  const d = s.task(id); fs.writeFileSync(path.join(d, 'change.diff'), 'diff');
  const lines = earlierWorkLines({ id, requeue_count: 2, removal_backup: '/b/x' }, s.wk);
  assert.match(lines[0], /requeued 2 times/);
  assert.ok(lines.some(l => l.includes('/b/x')) && lines.some(l => l.includes('change.diff')));
  assert.deepEqual(earlierWorkLines(null, s.wk), []);
});

test('earlierWorkLines lists every non-empty backup of a task requeued more than once', () => {
  const s = sandbox(), id = '20261124-190004-backups';
  s.task(id);
  const lines = earlierWorkLines({ id, requeue_count: 2, removal_backups: ['/b/one', '', '/b/two', '/b/two'], removal_backup: '/b/two' }, s.wk);
  assert.ok(lines.some(l => l.includes('/b/one')) && lines.some(l => l.includes('/b/two')), lines.join('\n'));
  assert.ok(lines.some(l => /2 of 2 \(newest\)/.test(l) && l.includes('/b/two')), lines.join('\n'));
  assert.equal(lines.filter(l => l.includes('/b/two')).length, 1, 'a repeated entry is listed once');
  assert.ok(!lines.some(l => /: *$/.test(l)), 'no empty entry');
});

test('the guard ignores a heartbeat from an earlier attempt\'s folder and touches the current one', () => {
  const s = sandbox(), id = '20261124-190005-attempts';
  const old = path.join(s.wk, 'worktrees', id), cur = path.join(s.wk, 'worktrees', `${id}.a2`);
  for (const d of [old, cur]) fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  s.task(id, { status: 'taken', attempt: 2, worktree: cur });
  const hb = path.join(s.wk, 'tasks', id, 'heartbeat');
  const guard = cwd => spawnSync(process.execPath, [path.join(root, 'bin', 'wk-guard.mjs')], { env: s.env({ CLAUDE_PROJECT_DIR: '' }),
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src', 'a.js') }, cwd }), encoding: 'utf8', timeout: 30000 });
  guard(old);
  assert.ok(!fs.existsSync(hb), 'the agent of attempt 1 keeps no life signal for attempt 2');
  guard(cur);
  assert.ok(fs.existsSync(hb) && Date.now() - fs.statSync(hb).mtimeMs < 60000, 'the current attempt\'s folder touches it');
  s.noAgents();
});

test('done from an earlier attempt is refused and names the saved backup; a bad --attempt is bad input', () => {
  const s = sandbox(), id = '20261124-190006-stale';
  const cur = path.join(s.wk, 'worktrees', `${id}.a2`); fs.mkdirSync(cur, { recursive: true });
  s.task(id, { status: 'taken', attempt: 2, requeue_count: 1, worktree: cur, repo: s.base, removal_backups: ['/b/attempt-1'], removal_backup: '/b/attempt-1' });
  const task = args => spawnSync(process.execPath, [path.join(root, 'bin', 'wk-task.mjs'), ...args], { env: s.env(), encoding: 'utf8', timeout: 60000 });
  // P2-276 round 2: changed to the new rule. Without --attempt, a taken task at attempt 2 may be the
  // current worker's own: the refusal names the attempt and both ways out.
  const r0 = task(['done', id]);
  assert.equal(r0.status, 1, r0.stdout + r0.stderr);
  assert.match(r0.stdout + r0.stderr, /this task is on attempt 2\. If your brief named attempt 2, run done again with --attempt 2\. If your brief named an earlier attempt, stop: the task was requeued and your earlier work is saved at \/b\/attempt-1\./);
  assert.doesNotMatch(r0.stdout + r0.stderr, /this task was requeued;/);
  const r1 = task(['done', id, '--attempt', '1']);
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  assert.match(r1.stdout + r1.stderr, /this task was requeued; your earlier work is saved at \/b\/attempt-1/);
  assert.match(r1.stdout + r1.stderr, /now attempt 2/);
  assert.equal(task(['done', id, '--attempt', 'two']).status, 2);
  const meta = JSON.parse(fs.readFileSync(path.join(s.wk, 'tasks', id, 'meta.json'), 'utf8'));
  assert.equal(meta.status, 'taken', 'nothing changed');
  const q = '20261124-190007-requeued';
  s.task(q, { status: 'queued', attempt: 2, requeue_count: 1, removal_backup: '/b/q' });
  const r2 = task(['done', q, '--attempt', '1']);
  assert.equal(r2.status, 1);
  assert.match(r2.stdout + r2.stderr, /saved at \/b\/q.*back in the queue/s);
  s.noAgents();
});

// ---------------------------------------------------------------- wk-watch check
// P2-276 review: changed to the new rule (at most 3 notifications per pass, then one "and N more"): the fourth item
// (the handoff for Claude) is summed up, and the Claude wording is checked on the third pass instead.
test('check counts tasks and handoffs, writes watch.json (0600) and notifies once per item', () => {
  const s = sandbox();
  s.task('20261124-190010-one'); s.task('20261124-190011-two'); s.task('20261124-190012-taken', { status: 'taken' });
  fs.mkdirSync(path.join(s.wk, 'tasks', 'not-a-task-id'));
  s.handoffs({
    a: { workspace: '/w/a', updated_at: '2026-11-24T19:00:00Z', to_engine: 'claude', title: 'for claude' },
    b: { workspace: '/w/b', updated_at: '2026-11-24T19:00:00Z', to_engine: 'antigravity', title: 'for gemini' },
    c: { workspace: '/w/c', updated_at: '2026-11-24T19:00:00Z', to_engine: 'claude', title: 'read already', consumed_by: 'claude' },
  });
  const r = json(s.run(['check', '--json'], { WK_WATCH_RECOVER_S: '0' }));
  assert.deepEqual(r.counts, { tasks_for_gemini: 2, handoffs_for_antigravity: 1, handoffs_for_claude: 1 });
  assert.equal(r.new_items.length, 4);
  const w = JSON.parse(fs.readFileSync(path.join(s.wk, 'watch.json'), 'utf8'));
  assert.deepEqual(w.counts, r.counts);
  assert.deepEqual(w.ids.tasks_for_gemini, ['20261124-190010-one', '20261124-190011-two']);
  assert.equal(fs.statSync(path.join(s.wk, 'watch.json')).mode & 0o777, 0o600);
  const sent = s.mark('osascript');
  assert.equal(sent.length, 4, sent.join('\n'));
  assert.ok(sent.some(l => l.includes('title of 20261124-190010-one') && l.includes('/wk-take-task in Antigravity')));
  assert.ok(!sent.some(l => l.includes('for claude')), 'the fourth item is summed up, not told on its own');
  assert.ok(sent.some(l => /And 1 more waiting item:/.test(l)), sent.join('\n'));

  const again = json(s.run(['check', '--json'], { WK_WATCH_RECOVER_S: '0' }));
  assert.equal(again.new_items.length, 0);
  assert.equal(s.mark('osascript').length, 4, 'nothing told twice');

  s.task('20261124-190013-three');
  s.handoffs({ a: { workspace: '/w/a', updated_at: '2026-11-24T19:05:00Z', to_engine: 'claude', title: 'newer for claude' } });
  const third = json(s.run(['check', '--json'], { WK_WATCH_RECOVER_S: '0' }));
  assert.deepEqual(third.new_items.map(i => i.id).sort(), ['/w/a@2026-11-24T19:05:00Z', '20261124-190013-three']);
  assert.equal(s.mark('osascript').length, 6);
  assert.ok(s.mark('osascript').slice(4).some(l => l.includes('newer for claude') && l.includes('/wk-take-task in Claude Code')));
  s.noAgents();
});

test('check sends at most 3 notifications per pass, then one "and N more"; nothing is told again', () => {
  const s = sandbox();
  for (let i = 0; i < 7; i++) s.task(`20261124-19005${i}-many`);
  const r = json(s.run(['check', '--json'], { WK_WATCH_RECOVER_S: '0' }));
  assert.equal(r.new_items.length, 7);
  assert.equal(r.notifications.length, 4);
  const sent = s.mark('osascript');
  assert.equal(sent.length, 4, sent.join('\n'));
  assert.equal(sent.filter(l => l.includes('A task waits for Gemini')).length, 3);
  assert.match(sent[3], /And 4 more waiting items:/);
  json(s.run(['check', '--json'], { WK_WATCH_RECOVER_S: '0' }));
  assert.equal(s.mark('osascript').length, 4, 'all 7 were marked as told');
  s.noAgents();
});

test('notify uses /usr/bin/osascript or WK_OSASCRIPT, never an osascript found on PATH', async () => {
  const src = fs.readFileSync(WATCH, 'utf8');
  assert.match(src, /process\.env\.WK_OSASCRIPT \|\| '\/usr\/bin\/osascript'/);
  assert.doesNotMatch(src, /onPath\('osascript'\)/);
  const s = sandbox();
  s.task('20261124-190060-seam');
  const decoy = path.join(s.base, 'decoy'); fs.mkdirSync(decoy);
  fs.writeFileSync(path.join(decoy, 'osascript'), `#!/bin/sh\nprintf x >> '${path.join(s.marks, 'decoy')}'\n`, { mode: 0o755 });
  json(s.run(['check', '--json'], { WK_WATCH_RECOVER_S: '0', PATH: `${decoy}:${s.bin}:/usr/bin:/bin` }));
  assert.deepEqual(s.mark('decoy'), [], 'the osascript on PATH is never used');
  assert.equal(s.mark('osascript').length, 1, 'the WK_OSASCRIPT seam is used');
});

test('the recover pass is tasks-only, with a 10-minute limit and SIGTERM', async () => {
  const m = await import('../bin/wk-watch.mjs');
  assert.deepEqual(m.RECOVER_ARGS, ['recover', '--surface', 'task', '--json']);
  assert.deepEqual(m.RECOVER_OPTS, { timeoutMs: 600000, killSignal: 'SIGTERM' });
  assert.equal(m.NOTIFY_MAX, 3);
  const wd = fs.readFileSync(path.join(root, 'bin', 'wk-watchdog.mjs'), 'utf8');
  assert.match(wd, /export function runWatchdogCli\(argv = process\.argv\.slice\(2\), opts = \{\}\)/);
});

test('sq doubles % and $ for systemd and escapes quotes and backslashes', async () => {
  const { sq } = await import('../bin/wk-watch.mjs');
  assert.equal(sq('/a b/$HOME/50%/"q"\\x'), '"/a b/$$HOME/50%%/\\"q\\"\\\\x"');
});

test('check on Linux notifies through notify-send', () => {
  const s = sandbox();
  s.task('20261124-190020-linux');
  json(s.run(['check', '--json'], { WK_WATCH_RECOVER_S: '0', WK_WATCH_PLATFORM: 'linux' }));
  const sent = s.mark('notify-send');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /title of 20261124-190020-linux/);
  assert.deepEqual(s.mark('osascript'), []);
});

test('the recover pass runs and starts no agent: agy, claude and gemini markers never appear', () => {
  const s = sandbox();
  s.task('20261124-190030-queued');
  s.handoffs({ a: { workspace: '/w/a', updated_at: '2026-11-24T19:00:00Z', to_engine: 'claude', title: 'x' } });
  const r = json(s.run(['check', '--json'], { WK_WATCH_RECOVER_S: '300' }));
  assert.equal(r.recovered_now, true);
  assert.equal(r.last_recover.code, 0, JSON.stringify(r.last_recover));
  const w = JSON.parse(fs.readFileSync(path.join(s.wk, 'watch.json'), 'utf8'));
  assert.ok(w.last_recover_at);
  const second = json(s.run(['check', '--json'], { WK_WATCH_RECOVER_S: '300' }));
  assert.equal(second.recovered_now, false, 'not due again within 5 minutes');
  json(s.run(['status', '--json']));
  s.noAgents();
});

test('an empty pass takes under 200 ms', () => {
  const s = sandbox();
  const r = json(s.run(['check', '--json'], { WK_WATCH_RECOVER_S: '0' }));
  assert.equal(r.new_items.length, 0);
  assert.ok(r.took_ms < 200, `took ${r.took_ms} ms`);
  assert.deepEqual(s.mark('osascript'), []);
  console.log(`# empty pass took_ms=${r.took_ms}`);
});

test('KILL: check does nothing and writes nothing', () => {
  const s = sandbox();
  s.task('20261124-190040-killed');
  fs.writeFileSync(path.join(s.wk, 'KILL'), 'stop\n');
  const r = json(s.run(['check', '--json']));
  assert.equal(r.killed, true);
  assert.ok(!fs.existsSync(path.join(s.wk, 'watch.json')));
  assert.deepEqual(s.mark('osascript'), []);
  assert.equal(json(s.run(['status', '--json'])).kill, true);
  s.noAgents();
});

// ---------------------------------------------------------------- install and uninstall
test('install on macOS writes the LaunchAgent and calls only the launchctl stub; uninstall moves it to a backup', () => {
  const s = sandbox();
  const r = s.run(['install']);
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(s.home, 'Library', 'LaunchAgents', 'com.tengo.watchkeeper-watch.plist');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /<key>Label<\/key><string>com\.tengo\.watchkeeper-watch<\/string>/);
  assert.match(body, /<key>StartInterval<\/key><integer>30<\/integer>/);
  assert.ok(body.includes(`<string>${WATCH}</string><string>check</string>`));
  assert.ok(body.includes(`<key>WK_HOME</key><string>${s.wk}</string>`));
  assert.ok(body.includes(path.join(s.wk, 'watch-launchd.log')));
  assert.ok(!/agy|claude|gemini/i.test(body.replace(WATCH, '')), 'the job runs the checker only');
  const calls = s.mark('launchctl');
  assert.ok(calls.some(c => c.startsWith('bootstrap ') && c.endsWith(file)), calls.join('\n'));
  assert.equal(json(s.run(['status', '--json'])).scheduler.installed, true);

  fs.appendFileSync(file, '<!-- changed -->\n');
  assert.equal(s.run(['install']).status, 0);
  const backups = () => fs.readdirSync(path.join(s.wk, 'backups')).filter(f => f.startsWith('com.tengo.watchkeeper-watch'));
  assert.equal(backups().length, 1, 'a changed old file is backed up before it is replaced');

  const u = s.run(['uninstall']);
  assert.equal(u.status, 0, u.stderr);
  assert.ok(!fs.existsSync(file));
  assert.equal(backups().length, 2, 'uninstall moves the file to a backup, it deletes nothing');
  assert.ok(s.mark('launchctl').some(c => c.startsWith('bootout ')));
  assert.equal(s.run(['uninstall']).status, 0, 'a second uninstall is harmless');
  s.noAgents();
});

test('install on Linux writes the systemd units, calls only the systemctl stub; uninstall moves them to backups', () => {
  const s = sandbox();
  const dir = path.join(s.home, '.config', 'systemd', 'user');
  const env = { WK_WATCH_PLATFORM: 'linux', WK_SYSTEMD_USER_DIR: dir, WK_SYSTEMCTL: path.join(s.bin, 'systemctl') };
  const r = s.run(['install'], env);
  assert.equal(r.status, 0, r.stderr);
  const service = fs.readFileSync(path.join(dir, 'watchkeeper-watch.service'), 'utf8');
  const timer = fs.readFileSync(path.join(dir, 'watchkeeper-watch.timer'), 'utf8');
  assert.match(service, /Type=oneshot/);
  assert.ok(service.includes(`"${WATCH}" check`));
  assert.ok(service.includes(`WK_HOME=${s.wk}`));
  assert.match(timer, /OnUnitActiveSec=30s/);
  assert.match(timer, /Unit=watchkeeper-watch\.service/);
  assert.ok(s.mark('systemctl').includes('--user enable --now watchkeeper-watch.timer'), s.mark('systemctl').join('\n'));
  const u = s.run(['uninstall'], env);
  assert.equal(u.status, 0, u.stderr);
  assert.ok(!fs.existsSync(path.join(dir, 'watchkeeper-watch.timer')));
  assert.equal(fs.readdirSync(path.join(s.wk, 'backups')).filter(f => f.startsWith('watchkeeper-watch')).length, 2);
  assert.ok(s.mark('systemctl').includes('--user disable --now watchkeeper-watch.timer'));
  s.noAgents();
});

test('install on Linux without systemctl says so and exits 2', () => {
  const s = sandbox();
  fs.rmSync(path.join(s.bin, 'systemctl'));
  const r = s.run(['install'], { WK_WATCH_PLATFORM: 'linux', WK_SYSTEMD_USER_DIR: path.join(s.base, 'units') });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /systemctl\) was not found/);
  assert.ok(!fs.existsSync(path.join(s.base, 'units')));
});
