// The Gemini queue (P2-223): wk-task, wk-suggest, wk-state, the Antigravity hook adapter and the Stop logger.
// Every test builds its own world: a temp HOME and WK_HOME, a temp git repository with a bare "origin" (to prove nothing
// is pushed), its own git config. The real ~/.wk, ~/.gemini and the kill switch are never touched; nothing runs agy.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const BIN = n => path.join(root, 'bin', n);
const realKill = path.join(os.homedir(), '.wk', 'KILL');
const realKillBefore = fs.existsSync(realKill);
const TASK_ID = /^\d{8}-\d{6}-[a-z0-9-]{1,40}$/, SUG_ID = /^S-\d{8}-\d{6}-[0-9a-f]{4}$/;

function world() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-gem-'));
  const home = path.join(base, 'home'), wk = path.join(home, '.wk'), repo = path.join(base, 'repo'), origin = path.join(base, 'origin.git'), proj = path.join(base, 'proj');
  for (const d of [home, repo, proj]) fs.mkdirSync(d, { recursive: true });
  const gitcfg = path.join(base, 'gitconfig');
  fs.writeFileSync(gitcfg, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n');
  const env = { ...process.env, HOME: home, WK_HOME: wk, CLAUDE_PROJECT_DIR: proj, GIT_CONFIG_GLOBAL: gitcfg, GIT_CONFIG_NOSYSTEM: '1' };
  delete env.WK_ORCHESTRATION; delete env.CLAUDE_PLUGIN_ROOT; delete env.WK_LANE; delete env.WK_QUARANTINE; delete env.WK_POLICY_SHA256;
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env }).trim();
  execFileSync('git', ['init', '-q', '--bare', origin], { env });
  g(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'export const x = 1;\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', 'init');
  g(repo, 'remote', 'add', 'origin', origin); g(repo, 'push', '-q', 'origin', 'main');   // the test itself sets up origin once
  const run = (bin, args, { input, extra = {} } = {}) => spawnSync(process.execPath, [BIN(bin), ...args], { cwd: proj, env: { ...env, ...extra }, encoding: 'utf8', input: input ?? '' });
  const task = (args, o) => run('wk-task.mjs', args, o), sug = (args, o) => run('wk-suggest.mjs', args, o);
  const add = (title, more = []) => { const r = task(['add', '--repo', repo, '--title', title, '--text', `Do: ${title}`, '--from', 'owner', ...more]); assert.equal(r.status, 0, r.stderr); const id = r.stdout.trim(); assert.match(id, TASK_ID); return id; };
  const meta = id => JSON.parse(fs.readFileSync(path.join(wk, 'tasks', id, 'meta.json'), 'utf8'));
  const lines = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const openSug = () => JSON.parse(sug(['list', '--open', '--json']).stdout);
  const originRefs = () => g(origin, 'for-each-ref', '--format=%(refname) %(objectname)');
  return { base, home, wk, repo, origin, proj, env, g, run, task, sug, add, meta, lines, openSug, originRefs, wt: id => path.join(wk, 'worktrees', id) };
}
const mode = p => (fs.statSync(p).mode & 0o777).toString(8);

test.after(() => assert.equal(fs.existsSync(realKill), realKillBefore, 'the real kill switch was not touched'));

test('add: id, files 0600 in folders 0700, the route, the guessed kind, and the refusals', () => {
  const w = world();
  const id = w.add('Rename the helper in src', ['--allow', 'src/**', '--test', 'true']);
  const m = w.meta(id);
  assert.equal(m.status, 'queued'); assert.equal(m.kind, 'quick', 'the word "rename" picks quick'); assert.equal(m.model, 'gemini-4-hydrogen-medium'); assert.equal(m.fallback, 'gemini-4-hydrogen-low');
  assert.deepEqual(m.allow, ['src/**']); assert.equal(m.test, 'true'); assert.equal(m.repo, fs.realpathSync(w.repo)); assert.equal(m.from, 'owner');
  for (const k of ['id', 'created_at', 'from', 'title', 'kind', 'model', 'fallback', 'repo', 'allow', 'test', 'status', 'taken_at', 'model_used', 'worktree', 'base', 'commit', 'done_at', 'note']) assert.ok(k in m, k);
  assert.equal(mode(w.wk), '700'); assert.equal(mode(path.join(w.wk, 'tasks')), '700'); assert.equal(mode(path.join(w.wk, 'tasks', id)), '700');
  assert.equal(mode(path.join(w.wk, 'tasks', id, 'meta.json')), '600'); assert.equal(mode(path.join(w.wk, 'tasks', id, 'task.md')), '600');
  assert.match(fs.readFileSync(path.join(w.wk, 'tasks', id, 'task.md'), 'utf8'), /^# Rename the helper in src\n\nDo: Rename/);
  const plain = w.add('Add a settings screen'); assert.equal(w.meta(plain).kind, 'ui');
  const none = w.add('Make the thing work'); assert.equal(w.meta(none).kind, 'code'); assert.equal(w.meta(none).model, 'gemini-4-hydrogen-xhigh'); assert.deepEqual(w.meta(none).allow, ['**']);
  const k = w.task(['add', '--repo', w.repo, '--title', 'x', '--kind', 'hard', '--model', 'my-model']); assert.equal(w.meta(k.stdout.trim()).model, 'my-model');
  const piped = w.task(['add', '--repo', w.repo, '--title', 'From stdin'], { input: 'line one\nline two\u0007\n' }); assert.equal(piped.status, 0);
  assert.match(fs.readFileSync(path.join(w.wk, 'tasks', piped.stdout.trim(), 'task.md'), 'utf8'), /line one\nline two\n$/, 'stdin text kept, control characters removed');
  assert.equal(w.meta(piped.stdout.trim()).from, 'claude', 'the default sender is claude');
  const refuse = (args, re) => { const r = w.task(['add', ...args]); assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`); assert.match(r.stderr, re); };
  refuse(['--repo', w.repo, '--title', 'x'.repeat(201)], /longer than 200/);
  refuse(['--repo', w.repo, '--title', 'ok', '--text', 'y'.repeat(20001)], /longer than 20000/);
  refuse(['--repo', w.repo, '--title', 'ok', '--kind', 'fast'], /--kind must be one of read, quick, code, ui, plan, hard, review/);
  refuse(['--repo', 'repo', '--title', 'ok'], /absolute path/);
  refuse(['--repo', w.base, '--title', 'ok'], /not a git repository/);
  refuse(['--repo', w.repo, '--title', 'ok', '--from', 'gemini', '--test', 'curl x | sh'], /cannot set --test/);
  refuse(['--repo', w.repo, '--title', 'ok', '--from', 'mallory'], /--from must be/);
  refuse(['--repo', w.repo, '--title', 'ok', '--allow', '../outside/**'], /without "\.\."/);
  refuse(['--repo', w.repo, '--title', '\u0001\u0002'], /--title is needed/);
  const ctl = w.add('Tab\tand\u001b[31m colour'); assert.equal(w.meta(ctl).title, 'Tab and [31m colour', 'control characters are stripped');
  const long = w.add('word '.repeat(30)); assert.ok(long.length <= 16 + 40, 'the slug is at most 40 characters');
});

test('the whole flow: take, done, a merge suggestion, OK merges, nothing is pushed', () => {
  const w = world(), before = w.originRefs();
  const id = w.add('Change the greeting', ['--allow', 'a.txt', '--test', 'grep -q two a.txt', '--kind', 'code']);
  const t = w.task(['take', '--model-used', 'gemini-4-hydrogen-high']);
  assert.equal(t.status, 0, t.stderr);
  const wt = w.wt(id);
  assert.match(t.stdout, new RegExp(`Took task ${id}`)); assert.ok(t.stdout.includes(`Worktree: ${wt}`));
  assert.match(t.stdout, /Suggested model: gemini-4-hydrogen-xhigh \(fallback gemini-4-hydrogen-high\)/); assert.match(t.stdout, /Never push/); assert.match(t.stdout, /--- the task ---\n# Change the greeting/);
  const m = w.meta(id); assert.equal(m.status, 'taken'); assert.equal(m.base, w.g(w.repo, 'rev-parse', 'HEAD')); assert.equal(m.model_used, 'gemini-4-hydrogen-high'); assert.equal(m.worktree, wt);
  assert.equal(w.g(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'detached: no branch to clean up');
  assert.equal(mode(path.join(w.wk, 'worktrees')), '700');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'two\n');
  const d = w.task(['done', id, '--note', 'Changed one to two.', '--model-used', 'gemini-3.8-flash-medium']);
  assert.equal(d.status, 0, d.stderr); assert.match(d.stdout, /Verified .*the test passes/);
  const v = w.meta(id); assert.equal(v.status, 'verified'); assert.equal(v.model_used, 'gemini-3.8-flash-medium'); assert.equal(v.note, 'Changed one to two.'); assert.match(v.commit, /^[0-9a-f]{40}$/);
  assert.equal(w.g(wt, 'log', '-1', '--format=%s'), 'Gemini: Change the greeting');
  const ver = JSON.parse(fs.readFileSync(path.join(w.wk, 'tasks', id, 'verify.json'), 'utf8'));
  assert.deepEqual(ver.files, ['a.txt']); assert.deepEqual(ver.out_of_scope, []); assert.equal(ver.test.cmd, 'grep -q two a.txt'); assert.equal(ver.test.code, 0);
  assert.match(fs.readFileSync(path.join(w.wk, 'tasks', id, 'change.diff'), 'utf8'), /^-one\n\+two$/m);
  for (const f of ['change.diff', 'verify.json']) assert.equal(mode(path.join(w.wk, 'tasks', id, f)), '600');
  const open = w.openSug(); assert.equal(open.length, 1);
  assert.match(open[0].id, SUG_ID); assert.equal(open[0].from, 'watchkeeper'); assert.deepEqual(open[0].action, { type: 'task-merge', ref: id });
  assert.match(open[0].title, /^Gemini finished "Change the greeting"\. Tests pass\. Merge it\?$/); assert.match(open[0].detail, /Model used: gemini-3.8-flash-medium/);
  assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), 'one\n', 'nothing reaches the repository before the owner says OK');
  const ok = w.sug(['decide', open[0].id, 'ok']);
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /Merged .*Nothing was pushed/);
  assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(w.meta(id).status, 'merged'); assert.ok(!fs.existsSync(wt), 'the worktree is removed'); assert.ok(!w.g(w.repo, 'worktree', 'list').includes(wt));
  assert.equal(w.openSug().length, 0);
  const inbox = w.lines(path.join(w.wk, 'owner-inbox.jsonl'));
  assert.equal(inbox.length, 1); assert.deepEqual(Object.keys(inbox[0]).sort(), ['at', 'choice', 'kind', 'ref', 'title']);
  assert.equal(inbox[0].kind, 'decision'); assert.equal(inbox[0].ref, open[0].id); assert.equal(inbox[0].choice, 'ok');
  assert.equal(mode(path.join(w.wk, 'owner-inbox.jsonl')), '600'); assert.equal(mode(path.join(w.wk, 'suggestions.jsonl')), '600');
  assert.equal(w.originRefs(), before, 'nothing was pushed');
  const again = w.sug(['decide', open[0].id, 'no']); assert.equal(again.status, 1); assert.match(again.stderr, /already answered/); assert.equal(again.stderr.trim().split('\n').length, 1);
  const list = JSON.parse(w.task(['list', '--json']).stdout); assert.equal(list[0].id, id);
  assert.match(w.task(['show', id]).stdout, /Status: merged/);
});

test('the kill switch stops take, done and merge', () => {
  const w = world();
  const id = w.add('Something to do');
  fs.mkdirSync(w.wk, { recursive: true }); fs.writeFileSync(path.join(w.wk, 'KILL'), '');
  const t = w.task(['take']); assert.equal(t.status, 3); assert.match(t.stdout, /Stop switch is on/); assert.equal(w.meta(id).status, 'queued');
  fs.rmSync(path.join(w.wk, 'KILL'));
  assert.equal(w.task(['take']).status, 0);
  fs.writeFileSync(path.join(w.wt(id), 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(w.wk, 'KILL'), '');
  const d = w.task(['done', id]); assert.equal(d.status, 3); assert.equal(w.meta(id).status, 'taken');
  fs.rmSync(path.join(w.wk, 'KILL'));
  assert.equal(w.task(['done', id]).status, 0);
  fs.writeFileSync(path.join(w.wk, 'KILL'), '');
  const sid = w.openSug()[0].id;
  const ok = w.sug(['decide', sid, 'ok']); assert.equal(ok.status, 1); assert.match(ok.stderr, /kill switch/); assert.equal(w.meta(id).status, 'verified');
  assert.equal(w.openSug().length, 1, 'a refused merge leaves the suggestion open');
});

test('the daily cap: the 13th take of the day is refused', () => {
  const w = world();
  for (let i = 0; i < 13; i++) w.add(`Task number ${i}`);
  for (let i = 0; i < 12; i++) { const r = w.task(['take']); assert.equal(r.status, 0, `take ${i}: ${r.stdout}${r.stderr}`); }
  const r = w.task(['take']); assert.equal(r.status, 4); assert.match(r.stdout, /cap of 12 tasks/);
  const queued = JSON.parse(w.task(['list', '--json']).stdout).filter(t => t.status === 'queued'); assert.equal(queued.length, 1);
});

test('two sessions never take the same task', async () => {
  const w = world();
  const id = w.add('Only one may take this');
  const go = () => new Promise(res => { const c = spawn(process.execPath, [BIN('wk-task.mjs'), 'take'], { cwd: w.proj, env: w.env }); let out = ''; c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { out += d; }); c.on('close', code => res({ code, out })); });
  const rs = await Promise.all([go(), go(), go()]);
  assert.equal(rs.filter(r => r.code === 0).length, 1, JSON.stringify(rs));
  assert.ok(rs.filter(r => r.code !== 0).every(r => r.code === 5 || /already taken/.test(r.out)), JSON.stringify(rs));
  assert.equal(w.meta(id).status, 'taken');
  assert.equal(w.task(['take', '--id', id]).status, 1, 'taking it by id again is refused');
});

test('scope globs: "**" covers nested folders, "*" stays inside one folder name, "?" is one character', () => {
  const w = world();
  const id = w.add('Nested change', ['--allow', 'src/**', '--allow', 'docs/*.md', '--allow', 'v?.txt']);
  w.task(['take']);
  const put = (rel) => { fs.mkdirSync(path.dirname(path.join(w.wt(id), rel)), { recursive: true }); fs.writeFileSync(path.join(w.wt(id), rel), 'x\n'); };
  ['src/a/b/deep.js', 'docs/ok.md', 'docs/sub/no.md', 'v1.txt', 'v10.txt'].forEach(put);
  const d = w.task(['done', id]); assert.equal(d.status, 1);
  const v = JSON.parse(fs.readFileSync(path.join(w.wk, 'tasks', id, 'verify.json'), 'utf8'));
  assert.deepEqual(v.out_of_scope.sort(), ['docs/sub/no.md', 'v10.txt']);
});

test('out of scope: a file outside the allowed globs, or one gates.json excludes, is not merged', () => {
  const w = world();
  const id = w.add('Fix the app', ['--allow', 'src/**']);
  w.task(['take']);
  fs.writeFileSync(path.join(w.wt(id), 'src', 'app.js'), 'export const x = 2;\n');
  fs.writeFileSync(path.join(w.wt(id), 'a.txt'), 'sneaky\n');
  const d = w.task(['done', id]); assert.equal(d.status, 1); assert.match(d.stderr, /Out of scope: a\.txt/);
  assert.equal(w.meta(id).status, 'out-of-scope');
  const v = JSON.parse(fs.readFileSync(path.join(w.wk, 'tasks', id, 'verify.json'), 'utf8')); assert.deepEqual(v.out_of_scope, ['a.txt']); assert.deepEqual(v.files.sort(), ['a.txt', 'src/app.js']);
  const s = w.openSug(); assert.equal(s.length, 1); assert.equal(s[0].action.type, 'none'); assert.match(s[0].title, /changed files outside "Fix the app"/);
  // fixed, done again passes
  fs.writeFileSync(path.join(w.wt(id), 'a.txt'), 'one\n');
  assert.equal(w.task(['done', id]).status, 0); assert.equal(w.meta(id).status, 'verified');
  // a secret file is out of scope even with "**"
  const id2 = w.add('Anything goes');
  w.task(['take']);
  fs.writeFileSync(path.join(w.wt(id2), '.env'), 'X=1\n');
  assert.equal(w.task(['done', id2]).status, 1); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.wk, 'tasks', id2, 'verify.json'), 'utf8')).out_of_scope, ['.env']);
});

test('a failed test: status failed, a plain suggestion, nothing committed; a fix passes', () => {
  const w = world();
  const id = w.add('Make the check pass', ['--test', 'grep -q fixed a.txt || { echo "not fixed yet"; exit 3; }']);
  w.task(['take']);
  fs.writeFileSync(path.join(w.wt(id), 'a.txt'), 'still broken\n');
  const d = w.task(['done', id]); assert.equal(d.status, 1); assert.match(d.stderr, /exited 3/); assert.match(d.stderr, /not fixed yet/);
  const m = w.meta(id); assert.equal(m.status, 'failed'); assert.equal(m.commit, null);
  assert.equal(w.g(w.wt(id), 'rev-parse', 'HEAD'), m.base, 'nothing committed');
  const v = JSON.parse(fs.readFileSync(path.join(w.wk, 'tasks', id, 'verify.json'), 'utf8')); assert.equal(v.test.code, 3); assert.match(v.test.tail, /not fixed yet/);
  const s = w.openSug(); assert.equal(s.length, 1); assert.equal(s[0].action.type, 'none'); assert.match(s[0].title, /failed its test/); assert.match(s[0].detail, /not fixed yet/);
  fs.writeFileSync(path.join(w.wt(id), 'a.txt'), 'fixed\n');
  assert.equal(w.task(['done', id]).status, 0); assert.equal(w.meta(id).status, 'verified');
  // a test the guard refuses never runs
  const id2 = w.add('Guarded test', ['--test', 'git push --force origin main']);
  w.task(['take']); fs.writeFileSync(path.join(w.wt(id2), 'a.txt'), 'x\n');
  const before = w.originRefs();
  const r = w.task(['done', id2]); assert.equal(r.status, 1); assert.equal(w.meta(id2).status, 'failed');
  assert.match(JSON.parse(fs.readFileSync(path.join(w.wk, 'tasks', id2, 'verify.json'), 'utf8')).test.tail, /watchkeeper blocked/);
  assert.equal(w.originRefs(), before, 'the push never ran');
});

test('no change: status no-change, the worktree is removed', () => {
  const w = world();
  const id = w.add('Look but do not touch');
  w.task(['take']);
  const d = w.task(['done', id]); assert.equal(d.status, 0); assert.match(d.stdout, /No change/);
  assert.equal(w.meta(id).status, 'no-change'); assert.ok(!fs.existsSync(w.wt(id)));
  assert.match(w.openSug()[0].title, /with no change/);
});

test('merge refuses while the repository has uncommitted changes to a touched file', () => {
  const w = world();
  const id = w.add('Edit a', ['--allow', 'a.txt']);
  w.task(['take']); fs.writeFileSync(path.join(w.wt(id), 'a.txt'), 'gemini\n'); assert.equal(w.task(['done', id]).status, 0);
  fs.writeFileSync(path.join(w.repo, 'a.txt'), 'owner was editing\n');
  const head = w.g(w.repo, 'rev-parse', 'HEAD');
  const sid = w.openSug()[0].id;
  const r = w.sug(['decide', sid, 'ok']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /uncommitted changes to a\.txt/); assert.equal(r.stderr.trim().split('\n').length, 1, 'one plain line');
  assert.equal(w.meta(id).status, 'verified'); assert.equal(w.g(w.repo, 'rev-parse', 'HEAD'), head); assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), 'owner was editing\n');
  assert.equal(w.openSug().length, 1, 'still waiting for the owner');
  // a change to an untouched file does not block
  fs.writeFileSync(path.join(w.repo, 'a.txt'), 'one\n'); fs.writeFileSync(path.join(w.repo, 'src', 'app.js'), 'local\n');
  assert.equal(w.task(['merge', id]).status, 0); assert.equal(w.meta(id).status, 'merged');
});

test('a conflict is undone cleanly and reported', () => {
  const w = world(), before = w.originRefs();
  const id = w.add('Edit a too', ['--allow', 'a.txt']);
  w.task(['take']); fs.writeFileSync(path.join(w.wt(id), 'a.txt'), 'gemini\n'); assert.equal(w.task(['done', id]).status, 0);
  fs.writeFileSync(path.join(w.repo, 'a.txt'), 'owner\n'); w.g(w.repo, 'commit', '-q', '-am', 'owner change');
  const head = w.g(w.repo, 'rev-parse', 'HEAD');
  const sid = w.openSug()[0].id;
  const r = w.sug(['decide', sid, 'ok']);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /conflicts/);
  assert.equal(w.meta(id).status, 'conflict');
  assert.equal(w.g(w.repo, 'rev-parse', 'HEAD'), head); assert.equal(w.g(w.repo, 'status', '--porcelain'), '', 'the repository is clean');
  assert.ok(!fs.existsSync(path.join(w.repo, '.git', 'MERGE_HEAD')));
  assert.ok(fs.existsSync(w.wt(id)), 'the change is kept in its worktree');
  const open = w.openSug(); assert.equal(open.length, 1); assert.match(open[0].title, /hit a conflict/);
  assert.equal(w.lines(path.join(w.wk, 'owner-inbox.jsonl')).length, 1);
  assert.equal(w.originRefs(), before);
  assert.equal(w.task(['discard', id]).status, 0); assert.ok(!fs.existsSync(w.wt(id)));
});

test('discard keeps change.diff; No on a merge suggestion discards', () => {
  const w = world();
  const id = w.add('Half done');
  w.task(['take']); fs.writeFileSync(path.join(w.wt(id), 'new.txt'), 'draft\n');
  const d = w.task(['discard', id]); assert.equal(d.status, 0); assert.match(d.stdout, /kept in its change\.diff/);
  assert.equal(w.meta(id).status, 'discarded'); assert.ok(!fs.existsSync(w.wt(id)));
  assert.match(fs.readFileSync(path.join(w.wk, 'tasks', id, 'change.diff'), 'utf8'), /\+draft/);
  assert.equal(w.task(['discard', id]).status, 1, 'twice is refused');
  const id2 = w.add('Rejected');
  w.task(['take']); fs.writeFileSync(path.join(w.wt(id2), 'a.txt'), 'no thanks\n'); assert.equal(w.task(['done', id2]).status, 0);
  const sid = w.openSug().find(s => s.action.ref === id2).id;
  const no = w.sug(['decide', sid, 'no', '--text', 'Not this way.']); assert.equal(no.status, 0, no.stderr);
  assert.equal(w.meta(id2).status, 'discarded'); assert.ok(fs.existsSync(path.join(w.wk, 'tasks', id2, 'change.diff')));
  assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), 'one\n');
  const row = w.lines(path.join(w.wk, 'owner-inbox.jsonl')).pop(); assert.equal(row.choice, 'no'); assert.equal(row.text, 'Not this way.');
});

test('nothing in the queue code can push: no push in any git argument list', () => {
  for (const f of ['wk-task.mjs', 'gemini-lib.mjs', 'wk-suggest.mjs', 'wk-state.mjs', 'wk-guard-agy.mjs', 'wk-gemini-log.mjs', 'antigravity-lib.mjs', 'wk-antigravity.mjs']) {
    const s = fs.readFileSync(BIN(f), 'utf8');
    assert.ok(!/['"]push['"]/.test(s), `${f} names a push`);
    assert.ok(!/(?<!\.)\bexec(Sync)?\(|shell:\s*true/.test(s), `${f} uses a shell for git`);
    assert.ok(!/\bagy\b['"]|spawn(Sync)?\(['"][^'"]*agy/.test(s), `${f} runs agy`);
    assert.ok(!/https?:\/\//.test(s.replace(/antigravity\.google\/docs[^\s)]*/g, '')), `${f} names a web address`);
  }
});

test('suggestions: add, later hides for 24 hours, decide writes the inbox row, list filters', async () => {
  const w = world();
  const a = w.sug(['add', '--from', 'gemini', '--title', 'Use the existing date picker?', '--detail', 'It saves a day.\nIt matches the site.']);
  assert.equal(a.status, 0, a.stderr); const id = a.stdout.trim(); assert.match(id, SUG_ID);
  const b = w.sug(['add', '--title', 'Second idea'], { input: 'piped detail' }); const id2 = b.stdout.trim();
  assert.equal(w.openSug().length, 2); assert.equal(w.openSug()[0].id, id2, 'newest first');
  assert.equal(w.openSug()[1].detail, 'It saves a day.\nIt matches the site.');
  const later = w.sug(['decide', id, 'later']); assert.equal(later.status, 0, later.stderr);
  assert.deepEqual(w.openSug().map(s => s.id), [id2]);
  process.env.WK_HOME = w.wk;
  try {
    const { readSuggestions } = await import(BIN('gemini-lib.mjs'));
    assert.equal(readSuggestions(Date.now() + 23 * 3600e3).find(s => s.id === id).state, 'later');
    assert.equal(readSuggestions(Date.now() + 25 * 3600e3).find(s => s.id === id).state, 'open', 'back after 24 hours');
  } finally { delete process.env.WK_HOME; }
  assert.equal(w.sug(['decide', id, 'ok', '--text', 'Yes, go.']).status, 0, 'a hidden one can still be answered');
  const decided = JSON.parse(w.sug(['list', '--decided', '--json']).stdout); assert.deepEqual(decided.map(s => s.id), [id]); assert.equal(decided[0].decision.text, 'Yes, go.');
  const inbox = w.lines(path.join(w.wk, 'owner-inbox.jsonl'));
  assert.deepEqual(inbox.map(r => r.choice), ['later', 'ok']); assert.ok(inbox.every(r => r.kind === 'decision' && r.ref === id && r.title === 'Use the existing date picker?'));
  const ev = w.lines(path.join(w.wk, 'suggestions.jsonl')).filter(r => r.status); assert.deepEqual(ev.map(e => e.status), ['later', 'ok']);
  // refusals and lengths
  const bad = (args, code, re) => { const r = w.sug(args); assert.equal(r.status, code, `${args.join(' ')}: ${r.stderr}`); assert.match(r.stderr, re); assert.equal(r.stderr.trim().split('\n').length, 1); };
  bad(['add', '--title', 't'.repeat(201)], 2, /longer than 200/);
  bad(['add', '--title', 'ok', '--detail', 'd'.repeat(4001)], 2, /longer than 4000/);
  bad(['add', '--title', 'ok', '--from', 'bot'], 2, /--from must be/);
  bad(['decide', 'S-20260101-000000-zzzz', 'ok'], 2, /give a suggestion id/);
  bad(['decide', 'S-20260101-000000-abcd', 'ok'], 2, /no suggestion/);
  bad(['decide', id2, 'maybe'], 2, /choice must be one of ok, later, no/);
  const c = w.sug(['add', '--title', 'Bell\u0007 and\u001b[2J clear'], { input: 'keeps\nnew lines\u0000' });   // a null byte can only come through stdin assert.equal(c.status, 0);
  const s = w.openSug().find(x => x.id === c.stdout.trim()); assert.equal(s.title, 'Bell and [2J clear'); assert.equal(s.detail, 'keeps\nnew lines');
  assert.match(w.sug(['list']).stdout, /from claude: Bell and/);
});

test('wk-state --json prints the documented object', () => {
  const w = world();
  const orch = path.join(w.base, 'elsewhere', 'orchestration'); fs.mkdirSync(orch, { recursive: true });   // not above the cwd
  fs.writeFileSync(path.join(orch, 'QUESTIONS.md'), ['# Questions', '',
    '- [x] Q1 (2026-10-15 22:26, tab ?): Already answered.',
    '- [ ] Q105 (2026-11-13 10:00, tab T-210): Which colour for the button? Recommended: teal, it matches the site.',
    '- [ ] Q106 (2026-11-14 09:12, tab T-215): Pay US$5 for the domain?',
    '- [ ] not a question line', ''].join('\n'));
  w.add('Queued work');
  w.sug(['add', '--title', 'An open idea']);
  const hid = w.sug(['add', '--title', 'Hidden idea']).stdout.trim(); w.sug(['decide', hid, 'later']);
  fs.mkdirSync(path.join(w.wk, 'gemini'), { recursive: true });
  fs.writeFileSync(path.join(w.wk, 'gemini', 'sessions.jsonl'), Array.from({ length: 25 }, (_, i) => JSON.stringify({ at: `2026-11-14T10:${String(i).padStart(2, '0')}:00Z`, conversation_id: `c${i}`, model: 'gemini-4-hydrogen-xhigh', workspace: '/w', reason: 'NO_TOOL_CALL' })).join('\n') + '\n');
  const r = w.run('wk-state.mjs', ['--json', '--orchestration', orch]);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(s), ['version', 'generated_at', 'questions', 'suggestions', 'tasks', 'gemini_sessions']);
  assert.equal(s.version, JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version);
  assert.ok(!isNaN(Date.parse(s.generated_at)));
  assert.deepEqual(s.questions.map(q => q.n), [106, 105], 'open only, newest number first');
  assert.equal(s.questions[1].recommended, 'teal, it matches the site.'); assert.equal(s.questions[0].recommended, null); assert.equal(s.questions[0].tab, 'T-215'); assert.equal(s.questions[0].at, '2026-11-14 09:12');
  assert.deepEqual(s.suggestions.map(x => x.title), ['An open idea']); assert.deepEqual(Object.keys(s.suggestions[0]).sort(), ['action', 'at', 'detail', 'from', 'id', 'title']);
  assert.equal(s.tasks.length, 1); assert.equal(s.tasks[0].status, 'queued'); assert.equal(s.tasks[0].model, 'gemini-4-hydrogen-xhigh');
  assert.equal(s.gemini_sessions.length, 20); assert.equal(s.gemini_sessions[0].conversation_id, 'c24', 'newest first');
  const viaEnv = JSON.parse(w.run('wk-state.mjs', ['--json'], { extra: { WK_ORCHESTRATION: orch } }).stdout); assert.equal(viaEnv.questions.length, 2);
  const none = JSON.parse(w.run('wk-state.mjs', ['--json']).stdout); assert.deepEqual(none.questions, [], 'no orchestration folder: no questions');
  const empty = JSON.parse(w.run('wk-state.mjs', ['--json'], { extra: { WK_HOME: path.join(w.base, 'nothing-here') } }).stdout);
  assert.deepEqual([empty.suggestions, empty.tasks, empty.gemini_sessions], [[], [], []]);
  assert.match(w.run('wk-state.mjs', []).stdout, /Suggestions waiting for you: 1\./);
});

// ---------------------------------------------------------------- the Antigravity hooks
const markConv = (wk, id) => { fs.mkdirSync(path.join(wk, 'gemini'), { recursive: true }); fs.appendFileSync(path.join(wk, 'gemini', 'guarded.jsonl'), JSON.stringify({ at: new Date().toISOString(), conversation_id: id }) + '\n'); };
const agyEvent = (name, args, extra = {}) => JSON.stringify({ conversationId: 'conv-1', workspacePaths: ['/tmp/ws'], modelName: 'gemini-4-hydrogen-xhigh', hookEventName: 'PreToolUse', toolCall: { id: 't1', name, args }, stepIdx: 3, cwd: '/tmp/ws', ...extra });
test('the guard adapter denies a force push and cat .env, passes npm test, and always exits 0', () => {
  const w = world();
  const hook = (input, extra) => { const r = w.run('wk-guard-agy.mjs', [], { input, extra: { CLAUDE_PROJECT_DIR: '', ...extra } }); assert.equal(r.status, 0, 'a hook must exit 0'); return JSON.parse(r.stdout); };
  const ws = path.join(w.base, 'ws'); fs.mkdirSync(ws);
  // this machine chose "allow" (the owner's Turbo setup, P2-223 S1); without that file the hook says "ask" (tested below)
  fs.mkdirSync(w.wk, { recursive: true }); fs.writeFileSync(path.join(w.wk, 'antigravity-hook.json'), JSON.stringify({ pass: 'allow', preset: null, policy: null, detected_at: new Date().toISOString(), source: 'flag' }));
  markConv(w.wk, 'conv-1');   // a Watchkeeper conversation (P2-223 item 12); the owner's own chats are tested below
  const ev = (name, args) => agyEvent(name, args, { workspacePaths: [ws], cwd: ws });
  const push = hook(ev('run_command', { CommandLine: 'git push --force origin main', Cwd: ws }));
  assert.equal(push.decision, 'deny'); assert.match(push.reason, /watchkeeper blocked \(bash\)/);
  const env = hook(ev('run_command', { CommandLine: 'cat .env' })); assert.equal(env.decision, 'deny'); assert.match(env.reason, /excluded path/);
  assert.deepEqual(hook(ev('run_command', { CommandLine: 'npm test', Cwd: ws })), { decision: 'allow' });
  for (const c of ['git push origin main', 'git -C /x push', 'cd x && git push']) { const p = hook(ev('run_command', { CommandLine: c })); assert.equal(p.decision, 'deny', c); assert.match(p.reason, /Gemini never pushes/); }
  assert.equal(hook(ev('run_command', { CommandLine: 'git status && echo push' })).decision, 'allow', 'the word push alone is fine');
  assert.equal(hook(ev('run_command', { commandLine: 'git reset --hard HEAD~1' })).decision, 'deny', 'another spelling of the argument');
  assert.equal(hook(ev('run_command', { Unknown: { nested: 'git push -f origin' } })).decision, 'deny', 'unknown shape: the whole args are checked');
  assert.equal(hook(ev('view_file', { AbsolutePath: '/x/proj/.env' })).decision, 'deny');
  assert.equal(hook(ev('view_file', { AbsolutePath: '/x/proj/src/app.js' })).decision, 'allow');
  assert.equal(hook(ev('write_to_file', { TargetFile: '/x/a.js', CodeContent: 'k="sk_live_' + 'a'.repeat(24) + '"' })).decision, 'deny', 'a secret in a write');
  assert.equal(hook(ev('multi_replace_file_content', { TargetFile: '/x/a.js', ReplacementChunks: [{ TargetContent: 'a', ReplacementContent: 'AKIA' + 'B'.repeat(16) }] })).decision, 'deny');
  assert.equal(hook(ev('replace_file_content', { TargetFile: path.join(root, 'config', 'gates.json'), ReplacementContent: '{}' })).decision, 'deny', 'the policy file is the owner\'s');
  assert.ok(fs.existsSync(path.join(ws, '.wk', 'blocked.log')), 'blocks are logged in the workspace, as for Claude');
  // the kill switch: reads pass, writes and commands stop
  fs.mkdirSync(w.wk, { recursive: true }); fs.writeFileSync(path.join(w.wk, 'KILL'), '');
  assert.equal(hook(ev('view_file', { AbsolutePath: '/x/proj/src/app.js' })).decision, 'allow');
  assert.equal(hook(ev('grep_search', { Query: 'TODO', SearchPath: ws })).decision, 'allow');
  const k = hook(ev('write_to_file', { TargetFile: '/x/a.js', CodeContent: 'x' })); assert.equal(k.decision, 'deny'); assert.match(k.reason, /kill switch/);
  assert.equal(hook(ev('run_command', { CommandLine: 'ls' })).decision, 'deny');
  fs.rmSync(path.join(w.wk, 'KILL'));
  // broken input fails closed, never open
  assert.equal(hook('not json').decision, 'deny');
  assert.equal(hook(JSON.stringify({ conversationId: 'conv-1', toolCall: {} })).decision, 'deny');
  assert.equal(hook(JSON.stringify({ conversationId: 'conv-1', toolCall: { name: 'run_command', args: '"git push --force"' } })).decision, 'deny', 'args as a JSON string');
  const noWs = w.run('wk-guard-agy.mjs', [], { input: JSON.stringify({ conversationId: 'conv-1', toolCall: { name: 'run_command', args: { CommandLine: 'git clean -fd' } } }) });
  assert.equal(JSON.parse(noWs.stdout).decision, 'deny'); assert.ok(fs.existsSync(path.join(w.home, '.wk', 'blocked.log')), 'no workspace: the log goes to ~/.wk');
});

test('the Stop logger appends one line, keeps the last 500 and lets Gemini stop', () => {
  const w = world();
  const stop = input => { const r = w.run('wk-gemini-log.mjs', [], { input }); assert.equal(r.status, 0); assert.deepEqual(JSON.parse(r.stdout), {}); };
  stop(JSON.stringify({ conversationId: 'conv-9', workspacePaths: ['/Users/x/Projects/app'], modelName: 'gemini-4-carbon-high', hookEventName: 'Stop', executionNum: 1, terminationReason: 'NO_TOOL_CALL', fullyIdle: true }));
  const f = path.join(w.wk, 'gemini', 'sessions.jsonl');
  const rows = w.lines(f); assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), ['at', 'conversation_id', 'model', 'workspace', 'reason']);
  assert.deepEqual({ ...rows[0], at: 'x' }, { at: 'x', conversation_id: 'conv-9', model: 'gemini-4-carbon-high', workspace: '/Users/x/Projects/app', reason: 'NO_TOOL_CALL' });
  assert.equal(mode(f), '600'); assert.equal(mode(path.join(w.wk, 'gemini')), '700');
  stop('garbage');   // still logs a row and still exits 0
  fs.writeFileSync(f, Array.from({ length: 505 }, (_, i) => JSON.stringify({ at: 'x', conversation_id: `old${i}` })).join('\n') + '\n');
  stop(JSON.stringify({ conversationId: 'newest', modelName: 'm\u0007odel' }));
  const kept = w.lines(f); assert.equal(kept.length, 500); assert.equal(kept[0].conversation_id, 'old6'); assert.equal(kept[499].conversation_id, 'newest'); assert.equal(kept[499].model, 'm odel');
});

// ---------------------------------------------------------------- P2-223 fix round (the fresh review's M1-M3, S1-S8)
const verifiedDocsTask = (w, title = 'Docs fix') => {
  fs.mkdirSync(path.join(w.repo, 'docs'), { recursive: true }); fs.writeFileSync(path.join(w.repo, 'docs', 'guide.md'), 'old\n');
  fs.writeFileSync(path.join(w.repo, 'src', 'core.js'), 'export const core = 1;\n');
  w.g(w.repo, 'add', '-A'); w.g(w.repo, 'commit', '-q', '-m', 'docs and core');
  const id = w.add(title, ['--allow', 'docs/**']);
  assert.equal(w.task(['take']).status, 0);
  fs.writeFileSync(path.join(w.wt(id), 'docs', 'guide.md'), 'new\n');
  const d = w.task(['done', id]); assert.equal(d.status, 0, d.stderr); assert.equal(w.meta(id).status, 'verified');
  return { id, sid: w.openSug().find(s => s.action.ref === id).id, head: w.g(w.repo, 'rev-parse', 'HEAD') };
};
const setMeta = (w, id, patch) => { const p = path.join(w.wk, 'tasks', id, 'meta.json'); fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf8')), ...patch })); };
const refusedUnchanged = (w, id, sid, head, re) => {
  const r = w.sug(['decide', sid, 'ok']);
  assert.equal(r.status, 1, r.stdout); assert.match(r.stderr, re); assert.match(r.stderr, /Nothing was changed/); assert.equal(r.stderr.trim().split('\n').length, 1, 'one plain line');
  assert.equal(w.g(w.repo, 'rev-parse', 'HEAD'), head, 'the repository did not move'); assert.equal(w.g(w.repo, 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(w.repo, 'src', 'core.js'), 'utf8'), 'export const core = 1;\n');
  assert.equal(w.meta(id).status, 'verified'); assert.equal(w.openSug().filter(s => s.id === sid).length, 1, 'still waiting for the owner');
};

test('M1: a rename out of src/ into an allowed folder is out of scope (the deletion of src/core.js counts)', () => {
  const w = world();
  fs.writeFileSync(path.join(w.repo, 'src', 'core.js'), 'export const core = 1;\n'); w.g(w.repo, 'add', '-A'); w.g(w.repo, 'commit', '-q', '-m', 'core');
  const id = w.add('Move docs', ['--allow', 'docs/**']);
  w.task(['take']);
  fs.mkdirSync(path.join(w.wt(id), 'docs')); w.g(w.wt(id), 'mv', 'src/core.js', 'docs/core.js');
  const d = w.task(['done', id]); assert.equal(d.status, 1); assert.match(d.stderr, /Out of scope: .*src\/core\.js/);
  assert.equal(w.meta(id).status, 'out-of-scope');
  const v = JSON.parse(fs.readFileSync(path.join(w.wk, 'tasks', id, 'verify.json'), 'utf8'));
  assert.deepEqual(v.out_of_scope, ['src/core.js']); assert.deepEqual(v.files.sort(), ['docs/core.js', 'src/core.js']);
  assert.match(fs.readFileSync(path.join(w.wk, 'tasks', id, 'change.diff'), 'utf8'), /^deleted file mode/m, 'the diff shows the deletion, not a rename');
  assert.ok(fs.existsSync(path.join(w.repo, 'src', 'core.js')));
});

test('M2: merge refuses a tampered meta.commit, a commit on a planted base, and a tampered change.diff; it changes nothing', () => {
  const w = world();
  const { id, sid, head } = verifiedDocsTask(w);
  const wt = w.wt(id), m = w.meta(id), diff = path.join(w.wk, 'tasks', id, 'change.diff'), saw = fs.readFileSync(diff);
  // the reviewer's rv-tamper: a src commit on top of the verified one, its sha written into meta.json
  fs.writeFileSync(path.join(wt, 'src', 'core.js'), 'gemini was here\n'); w.g(wt, 'commit', '-q', '-am', 'sneak');
  setMeta(w, id, { commit: w.g(wt, 'rev-parse', 'HEAD') });
  refusedUnchanged(w, id, sid, head, /not one commit on the version Gemini started from/);
  // one commit on base, but outside the allowed files
  w.g(wt, 'reset', '-q', '--hard', m.base); fs.writeFileSync(path.join(wt, 'src', 'core.js'), 'gemini was here\n'); w.g(wt, 'commit', '-q', '-am', 'sneak 2');
  setMeta(w, id, { commit: w.g(wt, 'rev-parse', 'HEAD') });
  refusedUnchanged(w, id, sid, head, /changes files outside the task \(src\/core\.js\)/);
  // one commit on base, in scope, but not the change the owner can view
  w.g(wt, 'reset', '-q', '--hard', m.base); fs.writeFileSync(path.join(wt, 'docs', 'guide.md'), 'something else\n'); w.g(wt, 'commit', '-q', '-am', 'other docs');
  setMeta(w, id, { commit: w.g(wt, 'rev-parse', 'HEAD') });
  refusedUnchanged(w, id, sid, head, /not the change you can view/);
  // a planted base: X changes src, Y (docs) on top; base=X, commit=Y and change.diff rewritten to match Y alone
  w.g(wt, 'reset', '-q', '--hard', m.base); fs.writeFileSync(path.join(wt, 'src', 'core.js'), 'planted\n'); w.g(wt, 'commit', '-q', '-am', 'X');
  const x = w.g(wt, 'rev-parse', 'HEAD'); fs.writeFileSync(path.join(wt, 'docs', 'guide.md'), 'new\n'); w.g(wt, 'commit', '-q', '-am', 'Y');
  fs.writeFileSync(diff, execFileSync('git', ['-C', wt, 'diff', '--binary', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--no-color', x, 'HEAD'], { env: w.env }));
  setMeta(w, id, { base: x, commit: w.g(wt, 'rev-parse', 'HEAD') });
  refusedUnchanged(w, id, sid, head, /not in your branch/);
  // the true commit with a tampered change.diff
  setMeta(w, id, { base: m.base, commit: m.commit });
  fs.writeFileSync(diff, Buffer.concat([saw, Buffer.from(' \n')]));
  refusedUnchanged(w, id, sid, head, /not the change you can view/);
  fs.writeFileSync(diff, saw);   // put back: the real change merges
  const ok = w.sug(['decide', sid, 'ok']); assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(path.join(w.repo, 'docs', 'guide.md'), 'utf8'), 'new\n'); assert.equal(fs.readFileSync(path.join(w.repo, 'src', 'core.js'), 'utf8'), 'export const core = 1;\n');
});

test('M2: change.diff is exactly the committed diff, even when Gemini committed on its own', () => {
  const w = world();
  const id = w.add('Edit a', ['--allow', 'a.txt']);
  w.task(['take']);
  fs.writeFileSync(path.join(w.wt(id), 'a.txt'), 'two\n'); w.g(w.wt(id), 'commit', '-q', '-am', 'gemini step 1');
  fs.writeFileSync(path.join(w.wt(id), 'a.txt'), 'three\n'); w.g(w.wt(id), 'commit', '-q', '-am', 'gemini step 2');
  assert.equal(w.task(['done', id]).status, 0);
  const m = w.meta(id);
  assert.equal(w.g(w.repo, 'rev-parse', `${m.commit}^`), m.base, 'one commit on base');
  const want = execFileSync('git', ['-C', w.repo, 'diff', '--binary', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--no-color', m.base, m.commit], { env: w.env });
  assert.ok(fs.readFileSync(path.join(w.wk, 'tasks', id, 'change.diff')).equals(want));
  assert.equal(w.task(['merge', id]).status, 0); assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), 'three\n');
});

test('M2: a meta.worktree pointing at another linked worktree is never used; that worktree stays untouched', () => {
  const w = world();
  const other = path.join(w.base, 'owner-wt'); w.g(w.repo, 'worktree', 'add', '-q', '--detach', other);
  fs.writeFileSync(path.join(other, 'unsaved.txt'), 'the owner\'s work in progress\n');
  const untouched = () => { assert.ok(fs.existsSync(other)); assert.equal(fs.readFileSync(path.join(other, 'unsaved.txt'), 'utf8'), 'the owner\'s work in progress\n'); assert.ok(w.g(w.repo, 'worktree', 'list').includes(other)); };
  // No on a verified task: discard removes only <data>/worktrees/<id>
  const a = w.add('First', ['--allow', 'a.txt']); w.task(['take']); fs.writeFileSync(path.join(w.wt(a), 'a.txt'), 'x\n'); assert.equal(w.task(['done', a]).status, 0);
  setMeta(w, a, { worktree: other });
  const sa = w.openSug().find(s => s.action.ref === a).id;
  assert.equal(w.sug(['decide', sa, 'no']).status, 0); untouched(); assert.ok(!fs.existsSync(w.wt(a)));
  // OK on a verified task: merge removes only its own worktree
  const b = w.add('Second', ['--allow', 'a.txt']); w.task(['take']); fs.writeFileSync(path.join(w.wt(b), 'a.txt'), 'y\n'); assert.equal(w.task(['done', b]).status, 0);
  setMeta(w, b, { worktree: other });
  const sb = w.openSug().find(s => s.action.ref === b).id;
  const ok = w.sug(['decide', sb, 'ok']); assert.equal(ok.status, 0, ok.stderr); untouched(); assert.ok(!fs.existsSync(w.wt(b)));
  // done and discard on a taken task ignore the field too
  const c = w.add('Third', ['--allow', 'a.txt']); w.task(['take']); setMeta(w, c, { worktree: other });
  assert.equal(w.task(['done', c]).status, 0); assert.equal(w.meta(c).status, 'no-change'); untouched();
  // a symlink put in place of the worktree is removed, never followed
  const d = w.add('Fourth'); w.task(['take']);
  fs.rmSync(w.wt(d), { recursive: true, force: true }); fs.symlinkSync(other, w.wt(d));
  assert.equal(w.task(['done', d]).status, 1, 'done refuses a link in place of the worktree');
  assert.equal(w.task(['discard', d]).status, 0); untouched(); assert.ok(!fs.existsSync(w.wt(d)));
});

test('S3: git hook folders (.husky, .githooks, core.hooksPath) are out of scope unless allow names them', () => {
  const w = world();
  const one = (allow, file) => { const id = w.add(`Hook ${file}`, allow.flatMap(g => ['--allow', g])); w.task(['take']); fs.mkdirSync(path.dirname(path.join(w.wt(id), file)), { recursive: true }); fs.writeFileSync(path.join(w.wt(id), file), '#!/bin/sh\necho hi\n'); const r = w.task(['done', id]); w.task(['discard', id]); return { r, v: JSON.parse(fs.readFileSync(path.join(w.wk, 'tasks', id, 'verify.json'), 'utf8')) }; };
  for (const f of ['.husky/post-merge', '.githooks/pre-commit']) { const { r, v } = one(['**'], f); assert.equal(r.status, 1, f); assert.deepEqual(v.out_of_scope, [f]); }
  assert.equal(one(['.husky/**'], '.husky/post-merge').r.status, 0, 'allow names the folder');
  w.g(w.repo, 'config', 'core.hooksPath', 'tools/hooks');
  assert.deepEqual(one(['**'], 'tools/hooks/post-merge').v.out_of_scope, ['tools/hooks/post-merge']);
  assert.equal(one(['tools/hooks/**'], 'tools/hooks/post-merge').r.status, 0);
  w.g(w.repo, 'config', 'core.hooksPath', path.join(w.repo, 'abs-hooks'));
  assert.deepEqual(one(['**'], 'abs-hooks/post-merge').v.out_of_scope, ['abs-hooks/post-merge'], 'an absolute hooksPath inside the repository');
  w.g(w.repo, 'config', 'core.hooksPath', '.');
  assert.deepEqual(one(['**'], 'post-merge').v.out_of_scope, ['post-merge'], 'hooksPath at the top: hook names');
  assert.equal(one(['**'], 'notes.txt').r.status, 0, 'other top files are fine');
});

test('S4: staged changes in the repository: a plain refusal, nothing changes; after unstaging, OK merges', () => {
  const w = world();
  const id = w.add('Edit a', ['--allow', 'a.txt']);
  w.task(['take']); fs.writeFileSync(path.join(w.wt(id), 'a.txt'), 'gemini\n'); assert.equal(w.task(['done', id]).status, 0);
  fs.writeFileSync(path.join(w.repo, 'other.txt'), 'staged\n'); w.g(w.repo, 'add', 'other.txt');
  const head = w.g(w.repo, 'rev-parse', 'HEAD'), sid = w.openSug()[0].id;
  const r = w.sug(['decide', sid, 'ok']);
  assert.equal(r.status, 1); assert.equal(r.stderr.trim(), 'wk-suggest: You have staged changes in the repository. Commit or unstage them, then press OK again.');
  assert.equal(w.g(w.repo, 'rev-parse', 'HEAD'), head); assert.equal(w.g(w.repo, 'diff', '--cached', '--name-only'), 'other.txt', 'the staged file is left as it was');
  assert.equal(w.meta(id).status, 'verified'); assert.equal(w.openSug().length, 1);
  w.g(w.repo, 'restore', '--staged', 'other.txt');
  assert.equal(w.sug(['decide', sid, 'ok']).status, 0); assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), 'gemini\n');
});

test('S8: OK on a task merged elsewhere records the answer, replies "Already merged." and clears the suggestion', () => {
  const w = world();
  const id = w.add('Edit a', ['--allow', 'a.txt']);
  w.task(['take']); fs.writeFileSync(path.join(w.wt(id), 'a.txt'), 'two\n'); assert.equal(w.task(['done', id]).status, 0);
  const sid = w.openSug()[0].id;
  assert.equal(w.task(['merge', id]).status, 0, 'merged from the command line');
  const r = w.sug(['decide', sid, 'ok']);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'Already merged.');
  assert.equal(w.openSug().length, 0);
  const row = w.lines(path.join(w.wk, 'owner-inbox.jsonl')).pop(); assert.equal(row.ref, sid); assert.equal(row.choice, 'ok');
  const id2 = w.add('Edit a again', ['--allow', 'a.txt']);
  w.task(['take']); fs.writeFileSync(path.join(w.wt(id2), 'a.txt'), 'three\n'); assert.equal(w.task(['done', id2]).status, 0);
  const sid2 = w.openSug()[0].id; assert.equal(w.task(['discard', id2]).status, 0);
  const r2 = w.sug(['decide', sid2, 'ok']); assert.equal(r2.status, 0); assert.equal(r2.stdout.trim(), 'Already discarded.');
  assert.equal(fs.readFileSync(path.join(w.repo, 'a.txt'), 'utf8'), 'two\n', 'a discarded task never merges');
});

test('S5: readQuestions takes the last "Recommended:" marker and cuts it from the text, as the panel does', async () => {
  const { readQuestions } = await import(BIN('gemini-lib.mjs'));
  const orch = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-q-'));
  fs.writeFileSync(path.join(orch, 'QUESTIONS.md'), [
    '- [ ] Q107 (2026-11-14 10:00, tab T-219): Pick A or B? Recommended: A. The owner said later, Recommended: B, the cheaper one.',
    '- [ ] Q108 (2026-11-14 11:00, tab T-220): Only one? Recommended answer: yes.',
    '- [ ] Q109 (2026-11-14 12:00, tab T-221): No marker here.', ''].join('\n'));
  const q = Object.fromEntries(readQuestions(orch).map(x => [x.n, x]));
  assert.equal(q[107].recommended, 'B, the cheaper one.'); assert.equal(q[107].text, 'Pick A or B? Recommended: A. The owner said later,');
  assert.equal(q[108].recommended, 'yes.'); assert.equal(q[108].text, 'Only one?');
  assert.equal(q[109].recommended, null); assert.equal(q[109].text, 'No marker here.');
});

test('M3 and M2c: every tool meets the guard; unknown tools get "ask"; the pass decision is per machine; no file-tool writes into the data folder', () => {
  const w = world();
  const hook = (input, extra) => { const r = w.run('wk-guard-agy.mjs', [], { input, extra: { CLAUDE_PROJECT_DIR: '', ...extra } }); assert.equal(r.status, 0, 'a hook must exit 0'); return JSON.parse(r.stdout); };
  const ws = path.join(w.base, 'ws'); fs.mkdirSync(ws);
  const ev = (name, args) => agyEvent(name, args, { workspacePaths: [ws], cwd: ws });
  const hookFile = path.join(w.wk, 'antigravity-hook.json');
  fs.mkdirSync(w.wk, { recursive: true });
  markConv(w.wk, 'conv-1');   // a Watchkeeper conversation (P2-223 item 12)
  // no per-machine file: config/gemini.json says ask
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config', 'gemini.json'), 'utf8')).hook_pass_decision, 'ask', 'the tracked default is ask, for strangers');
  assert.deepEqual(hook(ev('view_file', { AbsolutePath: path.join(ws, 'a.js') })), { decision: 'ask' });
  // a known tool gets this machine's decision; any other tool gets ask
  for (const pass of ['allow', 'ask']) {
    fs.writeFileSync(hookFile, JSON.stringify({ pass, preset: null, policy: null, detected_at: new Date().toISOString(), source: 'flag' }));
    assert.equal(hook(ev('view_file', { AbsolutePath: path.join(ws, 'a.js') })).decision, pass);
    assert.equal(hook(ev('run_command', { CommandLine: 'npm test', Cwd: ws })).decision, pass);
    for (const t of [['read_url_content', { Url: 'example.com/page' }], ['mcp_x_y', { q: 'hello' }], ['browser_get_dom', {}], ['view_code_item', { File: path.join(ws, 'a.js') }]]) assert.deepEqual(hook(ev(...t)), { decision: 'ask' }, t[0]);
  }
  fs.writeFileSync(hookFile, '{bad json'); assert.equal(hook(ev('view_file', { AbsolutePath: path.join(ws, 'a.js') })).decision, 'ask', 'a bad file falls back to ask');
  fs.writeFileSync(hookFile, JSON.stringify({ pass: 'allow', source: 'flag' }));
  // secrets in the args of web and MCP tools; paths of unknown tools meet the deny globs
  assert.equal(hook(ev('read_url_content', { Url: 'example.com/?k=sk_live_' + 'a'.repeat(24) })).decision, 'deny');
  assert.equal(hook(ev('mcp_x_y', { Body: 'AKIA' + 'B'.repeat(16) })).decision, 'deny');
  assert.equal(hook(ev('view_code_item', { File: path.join(ws, '.env') })).decision, 'deny');
  assert.equal(hook(ev('some_new_tool', { DirectoryPath: ws, SourcePath: path.join(w.home, '.ssh', 'id_ed25519') })).decision, 'deny', 'a second path argument is checked too');
  assert.equal(hook(ev('some_new_tool', { DestinationPath: path.join(w.home, '.aws', 'credentials') })).decision, 'deny');
  assert.equal(hook(ev('some_new_tool', { DirectoryPath: ws, SourcePath: path.join(ws, 'a.js'), DestinationPath: path.join(ws, '.env') })).decision, 'deny', 'and a third');
  // the kill switch stops web, MCP and browser tools too
  fs.writeFileSync(path.join(w.wk, 'KILL'), '');
  for (const t of [['read_url_content', { Url: 'example.com' }], ['mcp_x_y', {}], ['browser_click', { Index: 1 }]]) { const k = hook(ev(...t)); assert.equal(k.decision, 'deny', t[0]); assert.match(k.reason, /kill switch/); }
  fs.rmSync(path.join(w.wk, 'KILL'));
  // M2c: no file-tool write into the data folder, except in worktrees/
  fs.mkdirSync(path.join(w.wk, 'tasks', 'x'), { recursive: true }); fs.mkdirSync(path.join(w.wk, 'worktrees', 'some-task'), { recursive: true });
  for (const [name, args] of [['write_to_file', { TargetFile: path.join(w.wk, 'tasks', 'x', 'meta.json'), CodeContent: '{}' }],
    ['replace_file_content', { TargetFile: path.join(w.wk, 'suggestions.jsonl'), ReplacementContent: 'x' }],
    ['multi_replace_file_content', { TargetFile: path.join(w.wk, 'worktrees', '..', 'tasks', 'x', 'change.diff'), ReplacementChunks: [] }],
    ['write_to_file', { TargetFile: path.join(w.wk, 'worktrees'), CodeContent: 'x' }],
    ['delete_file', { Path: path.join(w.wk, 'antigravity-hook.json') }]]) {
    const r = hook(ev(name, args)); assert.equal(r.decision, 'deny', `${name} ${JSON.stringify(args)}`); assert.match(r.reason, /data folder/);
  }
  assert.equal(hook(ev('write_to_file', { TargetFile: path.join(w.wk, 'worktrees', 'some-task', 'a.txt'), CodeContent: 'x' })).decision, 'allow', 'Gemini works in its worktree');
  assert.equal(hook(ev('view_file', { AbsolutePath: path.join(w.wk, 'tasks', 'x', 'meta.json') })).decision, 'allow', 'reading is fine');
  fs.symlinkSync(path.join(w.wk, 'tasks'), path.join(w.wk, 'worktrees', 'link'));
  assert.equal(hook(ev('write_to_file', { TargetFile: path.join(w.wk, 'worktrees', 'link', 'x', 'meta.json'), CodeContent: '{}' })).decision, 'deny', 'a link out of worktrees/ is followed first');
});

test('item 12: Watchkeeper rules apply only to the conversations that do Watchkeeper work; the owner\'s own chats get the pass decision', () => {
  const w = world();
  const hook = (input, extra) => { const r = w.run('wk-guard-agy.mjs', [], { input, extra: { CLAUDE_PROJECT_DIR: '', ...extra } }); assert.equal(r.status, 0, 'a hook must exit 0'); return JSON.parse(r.stdout); };
  const ws = path.join(w.base, 'ws'); fs.mkdirSync(ws);
  const ev = (conv, name, args, extra = {}) => JSON.stringify({ ...(conv ? { conversationId: conv } : {}), workspacePaths: [ws], cwd: ws, toolCall: { name, args }, ...extra });
  const guarded = path.join(w.wk, 'gemini', 'guarded.jsonl'), hookFile = path.join(w.wk, 'antigravity-hook.json');
  const marked = () => { try { return fs.readFileSync(guarded, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).conversation_id); } catch { return []; } };
  fs.mkdirSync(w.wk, { recursive: true });
  // the owner's own chat: no rule at all; no per-machine file means ask, the file's pass otherwise, for every tool
  assert.deepEqual(hook(ev('own-1', 'run_command', { CommandLine: 'git push origin main', Cwd: ws })), { decision: 'ask' });
  fs.writeFileSync(hookFile, '{bad'); assert.deepEqual(hook(ev('own-1', 'run_command', { CommandLine: 'git push origin main' })), { decision: 'ask' }, 'a bad file means ask');
  fs.writeFileSync(hookFile, JSON.stringify({ pass: 'allow', source: 'flag' }));
  for (const [name, args] of [['run_command', { CommandLine: 'git push origin main', Cwd: ws }], ['run_command', { CommandLine: 'git push --force origin main' }], ['run_command', { CommandLine: 'cat .env' }],
    ['read_url_content', { Url: 'example.com' }], ['mcp_x_y', { q: 1 }], ['browser_click', { Index: 1 }], ['write_to_file', { TargetFile: path.join(ws, 'a.js'), CodeContent: 'x' }]])
    assert.deepEqual(hook(ev('own-1', name, args)), { decision: 'allow' }, `${name} ${JSON.stringify(args)}`);
  // the kill switch is Watchkeeper's: the owner's chats go on
  fs.writeFileSync(path.join(w.wk, 'KILL'), '');
  assert.deepEqual(hook(ev('own-1', 'run_command', { CommandLine: 'git push origin main' })), { decision: 'allow' });
  assert.deepEqual(hook(ev('own-1', 'write_to_file', { TargetFile: path.join(ws, 'a.js'), CodeContent: 'x' })), { decision: 'allow' });
  fs.writeFileSync(hookFile, JSON.stringify({ pass: 'ask', source: 'flag' }));
  assert.deepEqual(hook(ev('own-1', 'run_command', { CommandLine: 'ls' })), { decision: 'ask' }, 'the pass decision, whatever it is');
  fs.rmSync(path.join(w.wk, 'KILL'));
  assert.deepEqual(marked(), [], 'the owner\'s chat is not marked');
  assert.ok(!fs.existsSync(path.join(ws, '.wk', 'blocked.log')) && !fs.existsSync(path.join(w.wk, 'blocked.log')), 'and nothing is logged');
  // a conversation that takes a task is marked by that call, and every later call meets the full rules
  fs.writeFileSync(hookFile, JSON.stringify({ pass: 'allow', source: 'flag' }));
  assert.deepEqual(hook(ev('wk-1', 'run_command', { CommandLine: `node ${path.join(root, 'bin', 'wk-task.mjs')} take t-1`, Cwd: ws })), { decision: 'allow' });
  assert.deepEqual(marked(), ['wk-1']);
  assert.equal((fs.statSync(guarded).mode & 0o777).toString(8), '600'); assert.equal((fs.statSync(path.dirname(guarded)).mode & 0o777).toString(8), '700');
  const p = hook(ev('wk-1', 'run_command', { CommandLine: 'git push origin main', Cwd: ws })); assert.equal(p.decision, 'deny'); assert.match(p.reason, /Gemini never pushes/);
  fs.mkdirSync(path.join(w.wk, 'tasks', 't-1'), { recursive: true });
  const d = hook(ev('wk-1', 'write_to_file', { TargetFile: path.join(w.wk, 'tasks', 't-1', 'meta.json'), CodeContent: '{}' })); assert.equal(d.decision, 'deny'); assert.match(d.reason, /data folder/);
  assert.equal(hook(ev('wk-1', 'read_url_content', { Url: 'example.com' })).decision, 'ask', 'in a Watchkeeper conversation an unknown tool gets ask');
  fs.writeFileSync(path.join(w.wk, 'KILL'), '');
  assert.match(hook(ev('wk-1', 'run_command', { CommandLine: 'ls' })).reason, /kill switch/);
  assert.deepEqual(hook(ev('own-1', 'run_command', { CommandLine: 'ls' })), { decision: 'allow' }, 'while another chat stays the owner\'s');
  fs.rmSync(path.join(w.wk, 'KILL'));
  assert.ok(fs.existsSync(path.join(ws, '.wk', 'blocked.log')), 'blocks in Watchkeeper conversations are logged');
  // the marking call meets the rules itself; every kind of Watchkeeper work marks
  const m2 = hook(ev('wk-2', 'run_command', { CommandLine: 'wk-task take t-2 && git push origin main' })); assert.equal(m2.decision, 'deny'); assert.match(m2.reason, /Gemini never pushes/);
  hook(ev('wk-3', 'run_command', { CommandLine: 'ls ~/.wk/tasks' }));
  hook(ev('wk-4', 'run_command', { CommandLine: 'npm test' }, { cwd: path.join(w.wk, 'worktrees', 't-1'), workspacePaths: [ws] }));
  hook(ev('wk-5', 'list_dir', { DirectoryPath: path.join(w.wk, 'tasks') }));
  hook(ev('wk-6', 'view_file', { AbsolutePath: path.join(ws, 'a.js') }, { workspacePaths: [path.join(w.wk, 'worktrees', 't-1')], cwd: undefined }));
  hook(ev('own-2', 'run_command', { CommandLine: 'echo wk-tasks; node bin/wk-taskmaster.mjs' }));
  assert.deepEqual(marked(), ['wk-1', 'wk-2', 'wk-3', 'wk-4', 'wk-5', 'wk-6'], 'a look-alike name does not mark');
  assert.equal(hook(ev('wk-4', 'run_command', { CommandLine: 'git push origin main', Cwd: ws })).decision, 'deny', 'once marked, always guarded');
  // no conversationId: each call is judged alone, and nothing is marked
  const tree = path.join(w.wk, 'worktrees', 't-1'); fs.mkdirSync(tree, { recursive: true });
  assert.equal(hook(ev(null, 'run_command', { CommandLine: 'git push origin main', Cwd: tree })).decision, 'deny', 'Watchkeeper work gets the full rules');
  assert.deepEqual(hook(ev(null, 'run_command', { CommandLine: 'git push origin main', Cwd: ws })), { decision: 'allow' }, 'other work gets the pass decision');
  assert.equal(marked().length, 6);
  // the list keeps its last 500 lines
  fs.writeFileSync(guarded, Array.from({ length: 600 }, (_, i) => JSON.stringify({ at: 'x', conversation_id: `old-${i}` })).join('\n') + '\n');
  hook(ev('wk-7', 'run_command', { CommandLine: 'wk-state --json' }));
  const all = marked(); assert.equal(all.length, 500); assert.equal(all[499], 'wk-7'); assert.equal(all[0], 'old-101');
});
