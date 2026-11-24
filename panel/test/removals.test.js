'use strict';
// P2-272: pending worktree removals (reader, decision runner, row), once-per-task notice, child tracking, Stop switch labels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const B = require('../src/watchdog-bridge');
const R = require('../src/render');

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wk-removals-'));
function fixture(items) {
  const home = mk(), plugin = mk();
  fs.mkdirSync(path.join(home, 'watchdog'), { recursive: true });
  fs.writeFileSync(path.join(home, 'watchdog', 'pending-removals.json'), JSON.stringify({ version: 1, items }));
  fs.mkdirSync(path.join(plugin, 'core'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'core', 'watchdog.py'), '');
  // stub wk_cli: echoes one JSON line and records its argv
  fs.writeFileSync(path.join(plugin, 'core', 'wk_cli.py'),
    "import sys, json, os\nopen(os.path.join(os.environ['WK_HOME'], 'argv.txt'), 'w').write(' '.join(sys.argv[1:]))\n"
    + "print(json.dumps({'ok': True, 'task_id': sys.argv[3], 'decision': sys.argv[2], 'message': 'stub said ' + sys.argv[2]}))\n");
  return { home, plugin };
}
const item = (id, o = {}) => ({ task_id: id, worktree: `wt-${id}`, dirty: false, reason: 'hung_clean', first_seen_at: '2026-11-23T10:00:00Z', decision: null, removed_at: null, ...o });

test('reader skips decided and removed items, keeps a "later" whose time has passed', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const { home } = fixture({
    a: item('a'), b: item('b', { decision: 'approved' }), c: item('c', { decision: 'kept' }),
    d: item('d', { decision: 'later', later_until: '2026-11-23T11:00:00Z' }),
    e: item('e', { decision: 'later', later_until: '2026-11-23T13:00:00Z' }),
    f: item('f', { removed_at: '2026-11-23T09:00:00Z' }), g: item('g', { dirty: true, reason: 'hung_dirty' }),
  });
  assert.deepEqual(B.readPendingRemovals(home, now).map(x => x.task_id).sort(), ['a', 'd', 'g']);
  assert.equal(B.readPendingRemovals(path.join(home, 'nope'), now).length, 0);
});

test('decisions run python3 wk_cli.py watchdog <sub> <id> and return the message', async () => {
  const { home, plugin } = fixture({ a: item('a') });
  for (const [d, sub] of [['approve', 'approve-remove'], ['later', 'later'], ['keep', 'keep']]) {
    const r = await B.runRemovalDecision(home, plugin, d, 'a');
    assert.equal(r.ok, true);
    assert.equal(r.message, `stub said ${sub}`);
    assert.equal(fs.readFileSync(path.join(home, 'argv.txt'), 'utf8'), `watchdog ${sub} a`);
  }
});

test('decisions refuse bad input, unknown tasks, untrusted folders and the Stop switch (approve)', async () => {
  const { home, plugin } = fixture({ a: item('a') });
  assert.equal((await B.runRemovalDecision(home, plugin, 'nuke', 'a')).ok, false);
  assert.equal((await B.runRemovalDecision(home, plugin, 'keep', 'a; rm -rf /')).ok, false);
  assert.equal((await B.runRemovalDecision(home, plugin, 'keep', 'zzz')).ok, false);
  assert.equal((await B.runRemovalDecision(home, plugin, 'keep', 'a', { trusted: false })).ok, false);
  fs.writeFileSync(path.join(home, 'KILL'), '');
  const r = await B.runRemovalDecision(home, plugin, 'approve', 'a');
  assert.equal(r.ok, false);
  assert.match(r.message, /Stop switch/);
  assert.equal(fs.existsSync(path.join(home, 'argv.txt')), false, 'nothing ran');
});

test('the row shows the name, why it is listed, the three plain buttons and a message slot', () => {
  const html = R.renderWaiting({ now: Date.now(), removals: [{ task_id: 'a', worktree: 'wt-a', dirty: true, reason: 'hung_dirty', last_output_at: new Date(Date.now() - 3600e3).toISOString(), message: 'Backed up, then removed.', ok: true }] });
  assert.match(html, /wt-a/);
  assert.match(html, /dirty/);
  for (const w of ['OK, go ahead', 'Not now', '>No<']) assert.ok(html.includes(w), w);
  assert.match(html, /data-removal-msg="a"[^>]*>Backed up, then removed\./);
  assert.ok(!/Nothing waits/.test(html));
  const clean = R.renderWaiting({ now: Date.now(), removals: [{ task_id: 'b', worktree: 'wt-b', dirty: false, reason: 'hung_clean' }] });
  assert.match(clean, /clean/);
});

test('every label for ~/.wk/KILL says "Stop switch"', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'render.js'), 'utf8');
  assert.ok(!/kill switch/i.test(src));
  assert.match(src, /<h2 id="h-controls">Stop switch<\/h2>/);
  const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  assert.ok(!/kill switch/i.test(ext));
});

test('child tracking: killTrackedChildren ends a detached group and a plain child, never ourselves', async () => {
  const detached = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  const plain = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exits = [detached, plain].map(c => new Promise(r => c.once('exit', (code, sig) => r(sig))));
  const n = B.killTrackedChildren('SIGTERM');
  assert.ok(n >= 2);
  assert.deepEqual(await Promise.all(exits), ['SIGTERM', 'SIGTERM']);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});
