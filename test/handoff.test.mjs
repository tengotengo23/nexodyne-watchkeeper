// wk-handoff (P2-257): W asks a session for a continue file, and the next session loads it. WK_HOME and WK_CLAUDE_HOME point into
// a temp folder, so the real ~/.wk and ~/.claude are never touched. Run: node --test test/handoff.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), BIN = path.join(here, '..', 'bin', 'wk-handoff.mjs');
const H = await import(BIN);
let n = 0;
function env() {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-handoff-')); process.env.WK_HOME = path.join(t, 'wk'); process.env.WK_CLAUDE_HOME = path.join(t, 'claude');
  delete process.env.WK_METER; process.env.WK_STEWARD_DIR = path.join(t, 'wk', 'steward'); fs.mkdirSync(process.env.WK_HOME, { recursive: true }); fs.mkdirSync(process.env.WK_CLAUDE_HOME, { recursive: true });
  return t;
}
const transcript = (t, tokens, extra = []) => {
  const f = path.join(t, `tr${++n}.jsonl`);
  const line = (o) => JSON.stringify(o);
  fs.writeFileSync(f, [line({ type: 'user', message: { content: 'hi' } }), line({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0 } } }), ...extra].join('\n') + '\n'); return f;
};
const GOOD = `# Continue\n## Goal\nship it\n## Done\n- a thing, with its evidence\n## State\nnothing held\n## Next\n1. do the next thing\n## Decisions and rules\nnone\n## Resume prompt\nStart from step 1 and check the state first, then report.\n${'x'.repeat(200)}\n${H.END}\n`;
const meter = (over) => { fs.mkdirSync(process.env.WK_STEWARD_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.WK_STEWARD_DIR, 'meter.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), utilization: 0.3, resetsAt: Date.now() / 1000 + 86400, fiveHour: { utilization: 0.2, resetsAt: Date.now() / 1000 + 3600 }, ...over })); };

test('context tokens: the newest main-thread assistant message; a subagent line is skipped', () => {
  const t = env(), sub = JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 999999 } } });
  assert.equal(H.contextTokens(transcript(t, 160000, [sub])), 160000);
  assert.equal(H.contextTokens(path.join(t, 'missing.jsonl')), null);
});

test('a small session with a calm meter is left alone', () => {
  const t = env(); meter({});
  assert.equal(H.onStop({ session_id: 's-small', transcript_path: transcript(t, 40000), cwd: '/p' }), null);
});

test('a big context asks once, an incomplete file is sent back, a complete file makes it ready; then nothing more', () => {
  const t = env(), ev = { session_id: 's-big-1234', transcript_path: transcript(t, 170000), cwd: '/proj' };
  const a = H.onStop(ev); assert.equal(a.decision, 'block'); assert.match(a.reason, /about 170k tokens/); assert.match(a.reason, new RegExp(H.END));
  const file = readFile(a.reason); assert.ok(file.startsWith(path.join(process.env.WK_HOME, 'handoff')) && file.endsWith('.md'));
  const b = H.onStop(ev); assert.equal(b.decision, 'block'); assert.match(b.reason, /does not exist yet/);
  fs.writeFileSync(file, 'short'); assert.match(H.onStop(ev).reason, /shorter than/);
  const cfg = H.config(); fs.writeFileSync(file, GOOD.replace(H.END, 'nope')); assert.match(H.checkFile(file, cfg).why, /last line/);
  fs.writeFileSync(file, GOOD.replace('ship it', 'key sk_' + 'live_abcdefghijklmnop1234'));
  const gaveUp = H.onStop(ev); assert.match(gaveUp.systemMessage, /not usable/); assert.ok(!gaveUp.decision);
  assert.equal(H.onStop(ev), null, 'after giving up it does not nag');
});

test('ready: the owner is told to /clear; the session is not asked again', () => {
  const t = env(), ev = { session_id: 's-ready-aaaa', transcript_path: transcript(t, 160000), cwd: '/proj' };
  const file = readFile(H.onStop(ev).reason); fs.writeFileSync(file, GOOD);
  const r = H.onStop(ev); assert.match(r.systemMessage, /Type \/clear now/); assert.ok(!r.decision);
  assert.equal(H.onStop(ev), null);
  assert.equal(H.status().rows[0].state, 'ready');
});

test('the meter asks too (five-hour, weekly) when fresh, and is ignored when old or reset', () => {
  let t = env(); meter({ fiveHour: { utilization: 0.9, resetsAt: Date.now() / 1000 + 3600 } });
  assert.match(H.onStop({ session_id: 's-m1', transcript_path: transcript(t, 1000), cwd: '/p' }).reason, /five-hour usage limit is at 90%/);
  t = env(); meter({ utilization: 0.95 }); assert.match(H.onStop({ session_id: 's-m2', transcript_path: transcript(t, 1000), cwd: '/p' }).reason, /weekly usage limit is at 95%/);
  t = env(); meter({ utilization: 0.99, fetchedAt: new Date(Date.now() - 6 * 36e5).toISOString() }); assert.equal(H.onStop({ session_id: 's-m3', transcript_path: transcript(t, 1000), cwd: '/p' }), null);
  t = env(); meter({ utilization: 0.99, resetsAt: Date.now() / 1000 - 10 }); assert.equal(H.onStop({ session_id: 's-m4', transcript_path: transcript(t, 1000), cwd: '/p' }), null);
});

test("W's request asks every session until it runs out or is withdrawn", () => {
  const t = env(), cli = (...a) => spawnSync('node', [BIN, ...a], { encoding: 'utf8', env: process.env });
  assert.equal(cli('request').status, 2);
  assert.equal(cli('request', '--why', 'five-hour limit near', '--hours', '1').status, 0);
  assert.match(H.onStop({ session_id: 's-rq-0001', transcript_path: transcript(t, 1000), cwd: '/p' }).reason, /W asked every session.*five-hour limit near/);
  assert.equal(cli('request', '--off').status, 0);
  assert.equal(H.onStop({ session_id: 's-rq-0002', transcript_path: transcript(t, 1000), cwd: '/p' }), null);
  assert.match(cli('status').stdout, /asked/);
});

test('after /clear the one ready file of the folder is loaded once; other folders, startup and two ready files are not', () => {
  const t = env(), mk = (sid, cwd) => { const ev = { session_id: sid, transcript_path: transcript(t, 160000), cwd }; const f = readFile(H.onStop(ev).reason); fs.writeFileSync(f, GOOD.replace('ship it', `goal of ${sid}`)); H.onStop(ev); return f; };
  mk('s-one-aaaaaa', '/proj/a');
  assert.equal(H.onStart({ source: 'startup', cwd: '/proj/a', session_id: 'n1' }), null);
  assert.equal(H.onStart({ source: 'clear', cwd: '/proj/b', session_id: 'n1' }), null);
  const r = H.onStart({ source: 'clear', cwd: '/proj/a', session_id: 'n2' });
  assert.match(r.hookSpecificOutput.additionalContext, /goal of s-one-aaaaaa/); assert.ok(!r.hookSpecificOutput.additionalContext.includes(H.END));
  assert.equal(H.onStart({ source: 'clear', cwd: '/proj/a', session_id: 'n3' }), null, 'used once');
  mk('s-two-aaaaaa', '/proj/c'); mk('s-two-bbbbbb', '/proj/c');
  const two = H.onStart({ source: 'clear', cwd: '/proj/c', session_id: 'n4' }); assert.match(two.systemMessage, /2 continue files/); assert.ok(!two.hookSpecificOutput);
  assert.equal(H.onStart({ source: 'clear', cwd: '/proj/c', session_id: 's-two-aaaaaa' }) && 1, 1);
});

test('a hook never breaks a session: garbage on stdin prints nothing and exits 0; disabled does nothing', () => {
  const t = env();
  for (const c of ['stop', 'start']) { const r = spawnSync('node', [BIN, c], { input: 'not json', encoding: 'utf8', env: process.env }); assert.equal(r.status, 0); assert.equal(r.stdout, ''); }
  fs.writeFileSync(path.join(process.env.WK_HOME, 'handoff.json'), JSON.stringify({ enabled: false }));
  assert.equal(H.onStop({ session_id: 's-off', transcript_path: transcript(t, 900000), cwd: '/p' }), null);
});

test('status line: the real usage becomes the meter (0 to 1), nothing is written without numbers, and the meter then triggers the ask', () => {
  const t = env(), now = Date.now(), ev = { rate_limits: { five_hour: { used_percentage: 91, resets_at: now / 1000 + 3600 }, seven_day: { used_percentage: 40, resets_at: now / 1000 + 86400 } } };
  assert.equal(H.onStatusLine({}), ''); assert.equal(H.onStatusLine({ rate_limits: { five_hour: { used_percentage: null } } }), '');
  assert.ok(!fs.existsSync(path.join(process.env.WK_STEWARD_DIR, 'meter.json')));
  assert.equal(H.onStatusLine(ev, now), '5h 91% · week 40%');
  const m = JSON.parse(fs.readFileSync(path.join(process.env.WK_STEWARD_DIR, 'meter.json'), 'utf8'));
  assert.equal(m.utilization, 0.4); assert.equal(m.fiveHour.utilization, 0.91); assert.equal(m.source, 'statusline');
  assert.match(H.onStop({ session_id: 's-sl-0001', transcript_path: transcript(t, 1000), cwd: '/p' }).reason, /five-hour usage limit is at 91%/);
  const r = spawnSync('node', [BIN, 'statusline'], { input: JSON.stringify({ rate_limits: { seven_day: { used_percentage: 12, resets_at: now / 1000 + 5 } } }), encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0); assert.match(r.stdout, /7d 12%/);   // P2-272: the CLI prints the one shared status line (was /week 12%/)
});

test('install and uninstall: dry run changes nothing; apply backs up, keeps the other hooks, and is idempotent', () => {
  env(); const f = path.join(process.env.WK_CLAUDE_HOME, 'settings.json');
  const other = { hooks: { SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'echo other' }] }] }, model: 'opus' };
  fs.writeFileSync(f, JSON.stringify(other)); const before = fs.readFileSync(f, 'utf8'), cli = (...a) => spawnSync('node', [BIN, ...a], { encoding: 'utf8', env: process.env });
  assert.match(cli('install').stdout, /Would add/); assert.equal(fs.readFileSync(f, 'utf8'), before);
  assert.match(cli('install', '--apply').stdout, /Installed.*Backup/);
  let s = JSON.parse(fs.readFileSync(f, 'utf8')); assert.equal(s.model, 'opus'); assert.equal(s.hooks.Stop.length, 1); assert.equal(s.hooks.SessionStart.length, 2);
  assert.ok(s.hooks.SessionStart.some((m) => m.hooks[0].command === 'echo other'), 'the other hook stays');
  assert.equal(s.hooks.SessionStart.find((m) => m.matcher === 'clear').hooks[0].command.includes('wk-handoff.mjs'), true);
  assert.match(cli('install', '--apply').stdout, /already in place/);
  assert.equal(fs.readdirSync(path.join(process.env.WK_HOME, 'backups')).length, 1);
  assert.match(cli('uninstall', '--apply').stdout, /Removed/); s = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(s, other);
  fs.writeFileSync(f, JSON.stringify({ ...other, statusLine: { type: 'command', command: 'my-own-line' } }));
  assert.match(cli('install', '--apply').stdout, /already have a status line/); assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).statusLine.command, 'my-own-line');
  cli('uninstall', '--apply'); assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).statusLine.command, 'my-own-line', 'uninstall leaves a status line that is not ours');
  fs.writeFileSync(f, JSON.stringify(other)); cli('install', '--apply'); assert.match(JSON.parse(fs.readFileSync(f, 'utf8')).statusLine.command, /wk-handoff\.mjs" statusline/);
  cli('uninstall', '--apply'); assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), other);
  fs.writeFileSync(f, '{ not json'); assert.equal(cli('install', '--apply').status, 1); assert.equal(fs.readFileSync(f, 'utf8'), '{ not json');
});

function readFile(reason) { const m = reason.match(/exactly this path[^:]*: (\S+\.md)/); assert.ok(m, reason); fs.mkdirSync(path.dirname(m[1]), { recursive: true }); return m[1]; }
