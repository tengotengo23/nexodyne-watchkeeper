// wk-update and wk-release (P2-209). Every test builds its own world in a temp folder: a bare "GitHub" repo, the
// developer's clone and the other computer's clone, made from this folder's files. HOME, WK_HOME, the Gemini plugin
// folder, the editors (fake command lines) and launchd (a fake launchctl) all point into it, so the real ~/.wk,
// LaunchAgents, ~/.gemini and editors are never touched.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseVersion, cmpVersion, newestTag, plist, fetchProblem } from '../bin/wk-update.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const UPDATE = path.join(root, 'bin', 'wk-update.mjs'), RELEASE = path.join(root, 'bin', 'wk-release.mjs');
const CUR = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const NEXT = (([a, b]) => `${a}.${b + 1}.0`)(parseVersion(CUR));
const PANEL = 'nexodyne.watchkeeper-panel';
// the files wk-release bumps: public/README.md and the kit's INSTALL.html only where they exist (this repository has both, the public copy neither)
const ALWAYS = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'panel/package.json', 'antigravity/plugins/watchkeeper/plugin.json', 'README.md'];
const SOMETIMES = ['public/README.md', 'panel/install/INSTALL.html'];
const RELEASE_FILES = [...ALWAYS, ...SOMETIMES.filter(f => fs.existsSync(path.join(root, f)))];
const FILES = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).stdout.split('\0').filter(f => f && fs.existsSync(path.join(root, f)));

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-upd-')));
  const home = path.join(base, 'home'), bare = path.join(base, 'origin.git'), dev = path.join(base, 'dev'), user = path.join(base, 'user');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, WK_HOME: path.join(home, '.wk'), WK_UPDATE_REPO: user, WK_IDE_CLIS: '',
    WK_GEMINI_PLUGINS: path.join(home, '.gemini', 'config', 'plugins'), WK_SECRET_SCAN: '', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  delete env.CLAUDE_PLUGIN_ROOT;
  const g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  g(base, 'init', '-q', '--bare', '-b', 'main', bare);
  for (const f of FILES) { fs.mkdirSync(path.dirname(path.join(dev, f)), { recursive: true }); fs.copyFileSync(path.join(root, f), path.join(dev, f)); }
  g(dev, 'init', '-q', '-b', 'main'); g(dev, 'add', '-A'); g(dev, 'commit', '-q', '-m', 'start'); g(dev, 'tag', '-a', `v${CUR}`, '-m', 'start');
  g(dev, 'remote', 'add', 'origin', bare); g(dev, 'push', '-q', 'origin', 'main', '--tags');
  g(base, 'clone', '-q', bare, user);
  const w = { base, home, bare, dev, user, env, g,
    head: (d = user) => g(d, 'rev-parse', 'HEAD'),
    run: (args, extra = {}, bin = UPDATE) => spawnSync(process.execPath, [bin, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 180000 }),
    rec: () => JSON.parse(fs.readFileSync(path.join(env.WK_HOME, 'update.json'), 'utf8')),
    // the developer releases: the four version places, optional file edits, a commit, an annotated tag, a push
    release(v, edits = {}, { tag = `v${v}`, bump = true } = {}) {
      if (bump) {
        for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'panel/package.json']) {
          const p = path.join(dev, f); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/("version"\s*:\s*")\d+\.\d+\.\d+/, `$1${v}`));
        }
        const r = path.join(dev, 'README.md'); fs.writeFileSync(r, fs.readFileSync(r, 'utf8').replace(/^(# .*· v)\d+\.\d+\.\d+/, `$1${v}`));
      }
      for (const [f, s] of Object.entries(edits)) fs.appendFileSync(path.join(dev, f), s);
      g(dev, 'add', '-A'); g(dev, 'commit', '-q', '-m', `release ${v}`);
      if (tag) g(dev, 'tag', '-a', tag, '-m', tag);
      g(dev, 'push', '-q', 'origin', 'main', '--tags');
      return g(dev, 'rev-parse', 'HEAD');
    },
    // an editor's command line: lists and installs extensions in its own state file, and logs every call
    ide(name, installed) {
      const f = path.join(base, name), st = `${f}.json`, calls = `${f}.calls`;
      fs.writeFileSync(st, JSON.stringify(installed));
      fs.writeFileSync(f, `#!${process.execPath}
const fs = require('fs'), cp = require('child_process'), a = process.argv.slice(2), st = ${JSON.stringify(st)};
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + '\\n');
const s = JSON.parse(fs.readFileSync(st, 'utf8'));
if (a[0] === '--list-extensions') { for (const [k, v] of Object.entries(s)) console.log(k + '@' + v); process.exit(0); }
if (a[0] === '--install-extension' && a[2] === '--force' && fs.existsSync(a[1])) {
  s[${JSON.stringify(PANEL)}] = JSON.parse(cp.execFileSync('unzip', ['-p', a[1], 'extension/package.json'])).version;
  fs.writeFileSync(st, JSON.stringify(s)); console.log('installed'); process.exit(0);
}
console.error('bad call'); process.exit(2);
`, { mode: 0o755 });
      return { cli: f, state: () => JSON.parse(fs.readFileSync(st, 'utf8')), calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []) };
    },
  };
  return w;
}
const done = w => fs.rmSync(w.base, { recursive: true, force: true });

test('versions compare as numbers and the newest release tag wins', () => {
  assert.equal(cmpVersion('0.10.0', '0.9.9'), 1);
  assert.equal(cmpVersion('v1.2.3', '1.2.3'), 0);
  assert.equal(parseVersion('v1.2'), null);
  assert.equal(newestTag(['v0.2.0', 'v0.10.0', 'v0.9.1', 'v1.0.0-beta', 'x1.0.0', 'release']), 'v0.10.0');
  assert.equal(newestTag([]), null);
});

test('up to date: nothing moves and nothing is installed', () => {
  const w = world();
  try {
    const before = w.head(), ide = w.ide('editor-a', { 'other.ext': '1.0.0' });
    const r = w.run(['check'], { WK_IDE_CLIS: ide.cli });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Watchkeeper ${CUR.replace(/\./g, '\\.')} is up to date`));
    assert.equal(w.head(), before);
    const rec = w.rec();
    assert.equal(rec.result, 'up to date'); assert.equal(rec.newest, `v${CUR}`);
    assert.deepEqual(rec.steps.map(s => [s.what, s.state]), [['gemini', 'not installed']]);
    assert.deepEqual(ide.calls(), [['--list-extensions', '--show-versions']], 'an editor without the panel is only looked at');
    assert.match(fs.readFileSync(path.join(w.env.WK_HOME, 'update.log'), 'utf8'), /up to date v/);
  } finally { done(w); }
});

test('a new release: fast-forward, Gemini skill re-rendered, the panel reinstalled only where it is installed', () => {
  const w = world();
  try {
    const inst = spawnSync(process.execPath, [path.join(w.user, 'bin', 'wk-ask-claude.mjs'), 'install-antigravity', '--dest', w.env.WK_GEMINI_PLUGINS], { env: w.env, encoding: 'utf8' });
    assert.equal(inst.status, 0, inst.stderr);
    const a = w.ide('editor-a', { [PANEL]: CUR, 'other.ext': '1.0.0' }), b = w.ide('editor-b', { 'other.ext': '2.0.0' });
    const skill = 'antigravity/plugins/watchkeeper/skills/ask-claude/SKILL.md';
    const tagged = w.release(NEXT, { [skill]: '\nRelease test line.\n' });
    const r = w.run(['check'], { WK_IDE_CLIS: `${a.cli}:${b.cli}` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(w.head(), tagged, 'moved to the release');
    assert.equal(w.g(w.user, 'symbolic-ref', '--short', 'HEAD'), 'main', 'still on main');
    const rec = w.rec();
    assert.equal(rec.result, 'updated'); assert.deepEqual(rec.moved, { from: CUR, to: NEXT }); assert.equal(rec.version, NEXT);
    assert.match(fs.readFileSync(path.join(w.env.WK_GEMINI_PLUGINS, 'watchkeeper', 'skills', 'ask-claude', 'SKILL.md'), 'utf8'), /Release test line\./);
    assert.ok(fs.readdirSync(path.join(w.env.WK_HOME, 'backups')).some(f => f.startsWith('antigravity-plugin-')), 'the old skill is backed up');
    assert.equal(a.state()[PANEL], NEXT, 'the panel in editor A is the new version (read from the built vsix)');
    assert.deepEqual(b.state(), { 'other.ext': '2.0.0' });
    assert.ok(!b.calls().some(c => c[0] === '--install-extension'), 'editor B is never installed into');
    assert.deepEqual(rec.steps.map(s => [s.what, s.state]), [['gemini', 'updated'], ['panel', 'updated']]);
    assert.match(r.stdout, new RegExp(`Updated to ${NEXT.replace(/\./g, '\\.')} \\(was ${CUR.replace(/\./g, '\\.')}\\)`));
    const s = w.run(['status']);
    assert.match(s.stdout, /Updated to/);
    const again = w.run(['check'], { WK_IDE_CLIS: `${a.cli}:${b.cli}` });
    assert.equal(again.status, 0); assert.equal(w.rec().result, 'up to date');
    assert.deepEqual(w.rec().steps.map(x => x.state), ['current', 'current'], 'a second check changes nothing');
  } finally { done(w); }
});

test('plain commits on main do not move this computer', () => {
  const w = world();
  try {
    const before = w.head();
    w.release(NEXT, { 'README.md': '\nwork in progress\n' }, { tag: null, bump: false });
    const r = w.run(['check']);
    assert.equal(r.status, 0); assert.equal(w.head(), before); assert.equal(w.rec().result, 'up to date');
  } finally { done(w); }
});

test('uncommitted changes stop the move and stay as they are', () => {
  const w = world();
  try {
    const before = w.head(); w.release(NEXT);
    fs.appendFileSync(path.join(w.user, 'README.md'), '\nmy note\n');
    const r = w.run(['check']);
    assert.equal(r.status, 1);
    assert.equal(w.head(), before);
    assert.match(fs.readFileSync(path.join(w.user, 'README.md'), 'utf8'), /my note/);
    const rec = w.rec(); assert.equal(rec.result, 'problem'); assert.match(rec.problem, /not committed/);
    assert.match(rec.held, /not at release/); assert.deepEqual(rec.steps, [], 'the installed copies are not made from an edited folder');
    assert.match(r.stdout, /was not updated/);
  } finally { done(w); }
});

test('own commits: no fast-forward, the folder needs a hand', () => {
  const w = world();
  try {
    fs.appendFileSync(path.join(w.user, 'README.md'), '\nlocal\n');
    w.g(w.user, 'commit', '-q', '-am', 'local'); const mine = w.head();
    w.release(NEXT);
    const r = w.run(['check']);
    assert.equal(r.status, 1); assert.equal(w.head(), mine); assert.match(w.rec().problem, /own commits/);
  } finally { done(w); }
});

test('a broken release is not installed', () => {
  const w = world();
  try {
    const before = w.head(); w.release(NEXT, { 'bin/wk-ledger.mjs': '\nthis is not ( javascript\n' });
    const r = w.run(['check']);
    assert.equal(r.status, 1); assert.equal(w.head(), before);
    assert.match(w.rec().problem, /broken file \(bin\/wk-ledger\.mjs\)/);
  } finally { done(w); }
});

test('a tag whose files carry another version is refused', () => {
  const w = world();
  try {
    const before = w.head(); w.release('9.9.9', { 'README.md': '\nx\n' }, { bump: false });
    const r = w.run(['check']);
    assert.equal(r.status, 1); assert.equal(w.head(), before);
    assert.match(w.rec().problem, new RegExp(`v9\\.9\\.9 says version ${CUR.replace(/\./g, '\\.')} inside`));
  } finally { done(w); }
});

test('offline: says so and changes nothing', () => {
  const w = world();
  try {
    const before = w.head(); fs.renameSync(w.bare, `${w.bare}-gone`);
    const r = w.run(['check']);
    assert.equal(r.status, 1); assert.equal(w.head(), before); assert.match(w.rec().problem, /could not reach GitHub/);
  } finally { done(w); }
});

test('the kill switch pauses the check', () => {
  const w = world();
  try {
    const before = w.head(); w.release(NEXT);
    fs.mkdirSync(path.join(w.home, '.wk'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.wk', 'KILL'), 'stop\n');
    const r = w.run(['check']);
    assert.equal(r.status, 0); assert.equal(w.head(), before); assert.equal(w.rec().result, 'paused');
    assert.match(r.stdout, /paused/);
  } finally { done(w); }
});

test('dry run: says what it would do and changes nothing', () => {
  const w = world();
  try {
    const before = w.head(), a = w.ide('editor-a', { [PANEL]: CUR }); w.release(NEXT);
    const r = w.run(['check', '--dry-run'], { WK_IDE_CLIS: a.cli });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`Would update to ${NEXT.replace(/\./g, '\\.')}`));
    assert.equal(w.head(), before);
    assert.ok(!fs.existsSync(path.join(w.env.WK_HOME, 'update.json')));
    assert.ok(!a.calls().some(c => c[0] === '--install-extension')); assert.equal(a.state()[PANEL], CUR);
  } finally { done(w); }
});

test('a running check holds the lock; a stale lock is cleared', () => {
  const w = world();
  try {
    const lock = path.join(w.env.WK_HOME, 'update.lock');
    fs.mkdirSync(w.env.WK_HOME, { recursive: true });
    fs.writeFileSync(lock, `${process.pid} ${Date.now()}\n`);
    let r = w.run(['check']);
    assert.equal(r.status, 0); assert.match(r.stdout, /Check skipped/); assert.match(r.stdout, /another check or a release is running/i);
    assert.ok(fs.existsSync(lock), 'the other check keeps its lock');
    const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(lock, `${gone} ${Date.now()}\n`);
    r = w.run(['check']);
    assert.equal(r.status, 0); assert.equal(w.rec().result, 'up to date'); assert.ok(!fs.existsSync(lock));
  } finally { done(w); }
});

test('install writes a launchd agent (every 3 hours and at login); a changed one is backed up; uninstall keeps a copy', () => {
  const w = world();
  try {
    const agents = path.join(w.base, 'agents'), log = path.join(w.base, 'launchctl.log'), fake = path.join(w.base, 'launchctl');
    fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
    const env = { WK_LAUNCH_AGENTS: agents, WK_LAUNCHCTL: fake };
    let r = w.run(['install'], env);
    assert.equal(r.status, 0, r.stderr);
    const file = path.join(agents, 'com.tengo.watchkeeper-update.plist'), body = fs.readFileSync(file, 'utf8');
    assert.match(body, /<key>StartInterval<\/key><integer>10800<\/integer>/);
    assert.match(body, /<key>RunAtLoad<\/key><true\/>/);
    assert.ok(body.includes(`<string>${path.join(w.user, 'bin', 'wk-update.mjs')}</string><string>check</string>`));
    if (fs.existsSync('/usr/bin/plutil')) assert.equal(spawnSync('/usr/bin/plutil', ['-lint', file]).status, 0, 'a valid plist');
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(' ')[0]), ['bootout', 'bootstrap']);
    assert.match(r.stdout, /follows releases/); assert.equal(w.g(w.user, 'symbolic-ref', '--short', 'HEAD'), 'release');
    assert.equal(w.g(w.user, 'config', 'wk.role'), 'follower'); assert.equal(w.g(w.user, 'config', 'syncprojects.mode'), 'releases');
    r = w.run(['install'], { ...env, WK_UPDATE_EVERY_S: '7200' });
    assert.equal(r.status, 0); assert.match(fs.readFileSync(file, 'utf8'), /<integer>7200<\/integer>/);
    assert.equal(fs.readdirSync(path.join(w.env.WK_HOME, 'backups')).filter(f => f.endsWith('.plist')).length, 1, 'the old agent file is kept');
    r = w.run(['uninstall'], env);
    assert.equal(r.status, 0); assert.ok(!fs.existsSync(file));
    assert.equal(fs.readdirSync(path.join(w.env.WK_HOME, 'backups')).filter(f => f.endsWith('.plist')).length, 2);
  } finally { done(w); }
});

test('the plist escapes paths', () => {
  const p = plist({ node: '/a & b/node', script: '/x/<y>/wk-update.mjs', logFile: '/l' });
  assert.ok(p.includes('/a &amp; b/node') && p.includes('/x/&lt;y&gt;/wk-update.mjs') && !p.includes('<y>'));
});

test('wk-release: refuses what is not a release and dry-runs without touching a file', () => {
  const w = world();
  try {
    const env = { WK_UPDATE_REPO: w.dev };
    const files = RELEASE_FILES;
    const snap = () => files.map(f => fs.readFileSync(path.join(w.dev, f), 'utf8'));
    const before = snap(), head = w.head(w.dev);
    assert.equal(w.run([`v${NEXT}`], env, RELEASE).status, 2, 'a leading v is bad input');
    let r = w.run([CUR], env, RELEASE); assert.equal(r.status, 1); assert.match(r.stderr, /not newer/);
    r = w.run([NEXT, '--dry-run'], env, RELEASE); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, new RegExp(`Would release ${NEXT.replace(/\./g, '\\.')}`));
    assert.ok(r.stdout.includes(`(now ${CUR}): ${RELEASE_FILES.join(', ')}; tests;`), r.stdout);
    assert.deepEqual(snap(), before); assert.equal(w.head(w.dev), head);
    fs.appendFileSync(path.join(w.dev, 'README.md'), '\nunsaved\n');
    r = w.run([NEXT, '--no-push'], env, RELEASE); assert.equal(r.status, 1); assert.match(r.stderr, /changes to tracked files/);
    w.g(w.dev, 'checkout', '-q', '--', 'README.md');
    w.g(w.dev, 'tag', '-a', `v${NEXT}`, '-m', 'x');
    r = w.run([NEXT, '--no-push'], env, RELEASE); assert.equal(r.status, 1); assert.match(r.stderr, /exists already/);
    assert.equal(w.head(w.dev), head);
  } finally { done(w); }
});

test('wk-release in both shapes: this repository bumps public/README.md and INSTALL.html and stays strict; the public copy has neither and still releases', () => {
  const w = world();
  try {
    const env = { WK_UPDATE_REPO: w.dev };
    const dry = () => w.run([NEXT, '--dry-run'], env, RELEASE);
    const commit = m => { w.g(w.dev, 'add', '-A'); w.g(w.dev, 'commit', '-q', '-m', m); };
    const listed = r => r.stdout.split(`(now ${CUR}): `)[1].split('; tests;')[0].split(', ');
    // this repository's shape: both extra files are there and bumped
    fs.mkdirSync(path.join(w.dev, 'public'), { recursive: true }); fs.mkdirSync(path.join(w.dev, 'panel', 'install'), { recursive: true });
    fs.writeFileSync(path.join(w.dev, 'public', 'README.md'), `# Watchkeeper · v${CUR}\n\nThe public text.\n`);
    fs.writeFileSync(path.join(w.dev, 'panel', 'install', 'INSTALL.html'), `<p>Version ${CUR} · 1 November 2026</p>\n`);
    commit('full shape');
    let r = dry(); assert.equal(r.status, 0, r.stderr); assert.deepEqual(listed(r), [...ALWAYS, ...SOMETIMES]);
    // as strict as before: an INSTALL.html without the current version, or a title without "· vX.Y.Z", refuses
    fs.writeFileSync(path.join(w.dev, 'panel', 'install', 'INSTALL.html'), '<p>Version 0.0.1</p>\n'); commit('old kit');
    r = dry(); assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(`INSTALL\\.html does not mention ${CUR.replace(/\./g, '\\.')}`));
    fs.writeFileSync(path.join(w.dev, 'panel', 'install', 'INSTALL.html'), `<p>Version ${CUR}</p>\n`);
    fs.writeFileSync(path.join(w.dev, 'public', 'README.md'), '# Watchkeeper\n'); commit('no public version');
    r = dry(); assert.equal(r.status, 1); assert.match(r.stderr, /public\/README\.md title has no "· vX\.Y\.Z"/);
    // the public copy's shape: public/README.md is the README, no kit; the README title still has to carry the version
    fs.renameSync(path.join(w.dev, 'public', 'README.md'), path.join(w.dev, 'README.md'));
    fs.rmSync(path.join(w.dev, 'public'), { recursive: true, force: true }); fs.rmSync(path.join(w.dev, 'panel', 'install'), { recursive: true, force: true });
    commit('public shape, no version');
    r = dry(); assert.equal(r.status, 1); assert.match(r.stderr, /README title has no "· vX\.Y\.Z"/);
    fs.writeFileSync(path.join(w.dev, 'README.md'), `# Watchkeeper · v${CUR}\n\nThe public text.\n`); commit('public shape');
    const head = w.head(w.dev), readme = fs.readFileSync(path.join(w.dev, 'README.md'), 'utf8');
    r = dry(); assert.equal(r.status, 0, r.stderr); assert.deepEqual(listed(r), ALWAYS);
    assert.equal(fs.readFileSync(path.join(w.dev, 'README.md'), 'utf8'), readme, 'a dry run changes nothing'); assert.equal(w.head(w.dev), head);
  } finally { done(w); }
});

// ---------------------------------------------------------------- after the review (P2-209): roles, held copies, odd input
const fakeLaunchctl = (w, failFirst = 0) => {
  const log = path.join(w.base, 'launchctl.log'), n = path.join(w.base, 'launchctl.n'), fake = path.join(w.base, 'launchctl');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nif [ "$1" = bootstrap ]; then c=$(cat ${JSON.stringify(n)} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${JSON.stringify(n)}; [ $c -le ${failFirst} ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }; fi\nexit 0\n`, { mode: 0o755 });
  return { env: { WK_LAUNCH_AGENTS: path.join(w.base, 'agents'), WK_LAUNCHCTL: fake, WK_LAUNCHCTL_PAUSE_MS: '1' }, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(' ')[0]) };
};
const bumpPanel = (dir, v) => { const p = path.join(dir, 'panel', 'package.json'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/("version"\s*:\s*")\d+\.\d+\.\d+/, `$1${v}`)); };

test('the installed copies follow only a folder that sits exactly on the newest release', () => {
  const w = world();
  try {
    // (a) the maker's copy, ahead of the release with a bumped panel: nothing is built or installed
    const a = w.ide('editor-a', { [PANEL]: CUR });
    w.g(w.dev, 'config', 'wk.role', 'maker'); bumpPanel(w.dev, NEXT); w.g(w.dev, 'commit', '-q', '-am', 'work in progress');
    let r = w.run(['check'], { WK_UPDATE_REPO: w.dev, WK_IDE_CLIS: a.cli });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(w.rec().result, 'up to date'); assert.match(w.rec().held, new RegExp(`developer's copy, ahead of release v${CUR.replace(/\./g, '\\.')}`));
    assert.match(r.stdout, /left as they are/); assert.deepEqual(a.calls(), [], 'the editors are not even asked'); assert.equal(a.state()[PANEL], CUR);
    // (b) a release half made: the folder is at the tag, the bumped panel/package.json not committed yet
    w.g(w.dev, 'reset', '-q', '--hard', `v${CUR}`); bumpPanel(w.dev, NEXT);
    r = w.run(['check'], { WK_UPDATE_REPO: w.dev, WK_IDE_CLIS: a.cli });
    assert.equal(r.status, 0); assert.match(w.rec().held, /not committed/); assert.deepEqual(a.calls(), []); assert.equal(a.state()[PANEL], CUR);
    // (c) the other computer at the release with an edited skill: Gemini's copy is not re-rendered from it
    const inst = spawnSync(process.execPath, [path.join(w.user, 'bin', 'wk-ask-claude.mjs'), 'install-antigravity', '--dest', w.env.WK_GEMINI_PLUGINS], { env: w.env, encoding: 'utf8' });
    assert.equal(inst.status, 0, inst.stderr);
    fs.appendFileSync(path.join(w.user, 'antigravity/plugins/watchkeeper/skills/ask-claude/SKILL.md'), '\nlocal edit\n');
    r = w.run(['check']);
    assert.match(w.rec().held, /not committed/);
    assert.doesNotMatch(fs.readFileSync(path.join(w.env.WK_GEMINI_PLUGINS, 'watchkeeper', 'skills', 'ask-claude', 'SKILL.md'), 'utf8'), /local edit/);
  } finally { done(w); }
});

test('install: a follower goes on the newest release on its own branch; --maker stays on main; own commits are left alone', () => {
  const w = world();
  try {
    const tag = w.head(); w.release(NEXT, { 'README.md': '\nafter the release\n' }, { tag: null, bump: false });
    w.g(w.user, 'pull', '-q', '--ff-only'); const main = w.head();
    assert.notEqual(main, tag, 'this copy came from main, ahead of the release');
    const l = fakeLaunchctl(w);
    let r = w.run(['install'], l.env);
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, new RegExp(`branch "release" at v${CUR.replace(/\./g, '\\.')}`));
    assert.equal(w.g(w.user, 'symbolic-ref', '--short', 'HEAD'), 'release'); assert.equal(w.head(), tag);
    assert.equal(w.g(w.user, 'rev-parse', 'main'), main, 'main is kept as it was');
    r = w.run(['check']); assert.equal(r.status, 0, r.stdout); assert.equal(w.rec().held, null); assert.equal(w.rec().role, 'follower');
    r = w.run(['install'], l.env); assert.match(r.stdout, /follows releases \(branch release\)/, 'a second install keeps it');
    // the maker
    r = w.run(['install', '--maker'], { ...l.env, WK_UPDATE_REPO: w.dev });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /makes releases/);
    assert.equal(w.g(w.dev, 'config', 'wk.role'), 'maker'); assert.equal(w.g(w.dev, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.notEqual(spawnSync('git', ['-C', w.dev, 'config', '--get', 'syncprojects.mode']).status, 0, 'the sync keeps the maker');
    r = w.run(['install'], { ...l.env, WK_UPDATE_REPO: w.dev }); assert.match(r.stdout, /makes releases/, 'install without a flag keeps the role');
    // own commits
    const other = path.join(w.base, 'other'); w.g(w.base, 'clone', '-q', w.bare, other);
    fs.appendFileSync(path.join(other, 'README.md'), '\nmine\n'); w.g(other, 'commit', '-q', '-am', 'mine'); const mine = w.head(other);
    r = w.run(['install'], { ...l.env, WK_UPDATE_REPO: other });
    assert.match(r.stdout, /own commits/); assert.equal(w.g(other, 'symbolic-ref', '--short', 'HEAD'), 'main'); assert.equal(w.head(other), mine);
  } finally { done(w); }
});

test('launchd: a refused bootstrap is tried again, up to five times', () => {
  const w = world();
  try {
    let l = fakeLaunchctl(w, 2);
    let r = w.run(['install'], l.env);
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(l.calls(), ['bootout', 'bootstrap', 'bootstrap', 'bootstrap']);
    fs.rmSync(path.join(w.base, 'launchctl.log')); fs.rmSync(path.join(w.base, 'launchctl.n'));
    l = fakeLaunchctl(w, 99);
    r = w.run(['install'], l.env);
    assert.equal(r.status, 1); assert.match(r.stderr, /refused the agent five times/); assert.equal(l.calls().filter(c => c === 'bootstrap').length, 5);
  } finally { done(w); }
});

test('odd versions never crash a check; the record says what is wrong', () => {
  assert.equal(cmpVersion('v0.3.0', '0.2'), 1); assert.equal(cmpVersion('0.2', 'v0.3.0'), -1); assert.equal(cmpVersion(null, undefined), 0);
  const w = world();
  try {
    const p = path.join(w.user, '.claude-plugin', 'plugin.json');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/("version"\s*:\s*")\d+\.\d+\.\d+/, '$10.3.0-rc1'));
    const r = w.run(['check']);
    assert.equal(r.status, 1); assert.match(w.rec().problem, /says version "0\.3\.0-rc1", which is not X\.Y\.Z/);
    assert.match(fs.readFileSync(path.join(w.env.WK_HOME, 'update.log'), 'utf8'), /problem v0\.3\.0-rc1/);
  } finally { done(w); }
});

test('a release tag changed on GitHub is named as such, not as "offline"', () => {
  assert.match(fetchProblem('From x\n ! [rejected]        v0.3.0     -> v0.3.0  (would clobber existing tag)\n'), /release tag v0\.3\.0 on GitHub is not the one this computer has/);
  assert.match(fetchProblem('fatal: unable to access \'https://github.com/x/\': Could not resolve host: github.com'), /could not reach GitHub .*offline/);
  assert.match(fetchProblem('fatal: something new'), /^git fetch failed \(fatal: something new\)$/);
  const w = world();
  try {
    w.release(NEXT, { 'README.md': '\nx\n' }, { tag: null, bump: false });
    w.g(w.dev, 'tag', '-f', '-a', `v${CUR}`, '-m', 'moved'); w.g(w.dev, 'push', '-q', '-f', 'origin', `v${CUR}`);
    const r = w.run(['check']);
    assert.equal(r.status, 1); assert.match(w.rec().problem, new RegExp(`release tag v${CUR.replace(/\./g, '\\.')} on GitHub is not the one`));
    assert.doesNotMatch(w.rec().problem, /offline/);
  } finally { done(w); }
});

test('an index.lock older than an hour is named, with what to do', () => {
  const w = world();
  try {
    w.release(NEXT); const il = path.join(w.user, '.git', 'index.lock'); fs.writeFileSync(il, '');
    let r = w.run(['check']); assert.equal(w.rec().result, 'skipped', 'a fresh lock: next check retries');
    const old = new Date(Date.now() - 2 * 3600e3); fs.utimesSync(il, old, old);
    r = w.run(['check']);
    assert.equal(r.status, 1); assert.match(w.rec().problem, /busy here for over an hour .*delete that file by hand/);
  } finally { done(w); }
});

test('wk-release: a failing test puts the version files back; a running check holds it off', () => {
  const w = world();
  try {
    const env = { WK_UPDATE_REPO: w.dev };
    const files = RELEASE_FILES;
    const snap = () => files.map(f => fs.readFileSync(path.join(w.dev, f), 'utf8'));
    fs.writeFileSync(path.join(w.dev, 'test', 'run.mjs'), "console.log('a failing suite'); process.exit(1);\n");
    w.g(w.dev, 'commit', '-q', '-am', 'a failing suite');
    const before = snap(), head = w.head(w.dev);
    fs.mkdirSync(w.env.WK_HOME, { recursive: true });
    const lock = path.join(w.env.WK_HOME, 'update.lock');
    fs.writeFileSync(lock, `${process.pid} ${Date.now()}\n`);
    let r = w.run([NEXT, '--no-push'], env, RELEASE);
    assert.equal(r.status, 1); assert.match(r.stderr, /update check is running/); assert.deepEqual(snap(), before);
    fs.rmSync(lock);
    r = w.run([NEXT, '--no-push'], env, RELEASE);
    assert.equal(r.status, 1); assert.match(r.stderr, /tests failed in \. \(test\/run\.mjs\)/); assert.match(r.stderr, new RegExp(`back to ${CUR.replace(/\./g, '\\.')}`));
    assert.deepEqual(snap(), before, 'the version files are as they were');
    assert.equal(w.head(w.dev), head, 'nothing committed');
    assert.equal(spawnSync('git', ['-C', w.dev, 'diff', '--cached', '--quiet']).status, 0, 'nothing staged');
    assert.notEqual(spawnSync('git', ['-C', w.dev, 'rev-parse', '-q', '--verify', `refs/tags/v${NEXT}`]).status, 0, 'no tag');
    assert.ok(!fs.existsSync(path.join(w.dev, '.git', 'syncprojects.hold')), 'the sync hold is gone');
    assert.ok(!fs.existsSync(lock), 'the update lock is gone');
  } finally { done(w); }
});
