// P2-272 (B): `/wk sync` never indexes a staged source, and index.json has one writer.
// The sync runs in a fresh mkdtemp HOME and WK_HOME with no network: a sitecustomize stub makes every
// urllib call fail and a fake `git` on PATH only logs its arguments. The owner's real vault is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function skill(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} does one plain thing.\n---\n# ${name}\n## Use\nPlain words.\n`);
}

function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2b-sync-')));
  const vault = path.join(home, '.gemini', 'skill-vault');
  const wk = path.join(home, '.wk');
  fs.mkdirSync(wk, { recursive: true });
  // Three cloned sources: approved, staged (cloned anyway, as today) and rejected.
  for (const [slug, name] of [['good', 'good-skill'], ['fresh', 'staged-skill'], ['gone', 'rejected-skill']]) {
    const repo = path.join(vault, 'repos', slug);
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    skill(path.join(repo, 'skills', name), name);
  }
  fs.writeFileSync(path.join(vault, 'sources.json'), JSON.stringify({ version: 2, repos: [
    { slug: 'good', repo: 'o/good', url: 'https://github.com/o/good', tier: 1, stars: 10, approved: true, status: 'approved' },
    { slug: 'fresh', repo: 'o/fresh', url: 'https://github.com/o/fresh', tier: 2, stars: 900, approved: false, status: 'staged', staged_at: '2026-11-22T12:30:00Z' },
    { slug: 'gone', repo: 'o/gone', url: 'https://github.com/o/gone', tier: 2, stars: 5, approved: false, status: 'rejected' },
  ] }, null, 2));
  // No network: urllib fails at once; git only logs.
  const stub = path.join(home, 'stub');
  fs.mkdirSync(stub);
  fs.writeFileSync(path.join(stub, 'sitecustomize.py'),
    'import urllib.request\n' +
    'def _no_net(*a, **k):\n    raise OSError("network stubbed in test")\n' +
    'urllib.request.urlopen = _no_net\n');
  const binDir = path.join(home, 'fakebin');
  fs.mkdirSync(binDir);
  const gitLog = path.join(home, 'git-calls.log');
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\necho "$@" >> "${gitLog}"\nexit 0\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home, WK_HOME: wk, REPROMPT_SKILL_VAULT_DIR: vault,
    PYTHONPATH: stub, PYTHONDONTWRITEBYTECODE: '1', TMPDIR: home,
    PATH: `${binDir}:${process.env.PATH}`,
    GITHUB_TOKEN: '',
  };
  delete env.WK_LOG;
  return { home, vault, wk, env, gitLog };
}

test('/wk sync indexes approved sources only; a cloned staged or rejected source never reaches the index', () => {
  const { home, vault, env, gitLog } = sandbox();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'wk.mjs'), 'sync'], { cwd: home, env, encoding: 'utf8', timeout: 120000 });
  assert.match(r.stdout, /skill index, approved sources only/, r.stderr);
  assert.match(r.stdout, /graph refresh/, `the skill step passed: ${r.stderr}`);
  // --max-new 0 makes no GitHub search at all (P2-275: it once did, so this test hung on GitHub's rate limit).
  const st = JSON.parse(fs.readFileSync(path.join(home, '.wk', 'skill-sync.json'), 'utf8'));
  assert.deepEqual([st.ok, st.queries_ok, st.errors, st.discovered_total], [true, 0, [], 0], JSON.stringify(st).slice(0, 400));
  const idx = JSON.parse(fs.readFileSync(path.join(vault, 'index.json'), 'utf8'));
  const names = (idx.skills || []).map(s => s.name).sort();
  assert.deepEqual(names, ['good-skill']);
  assert.ok(!(idx.skills || []).some(s => s.slug === 'fresh' || s.slug === 'gone'));
  assert.equal(idx.skill_count, 1);
  // Git touched only the approved clone (a pull), never the staged or rejected one.
  const calls = fs.existsSync(gitLog) ? fs.readFileSync(gitLog, 'utf8') : '';
  assert.ok(!/repos\/(fresh|gone)/.test(calls), calls);
  // --max-new 0: no source was discovered (the bundled curated list may merge in, approved); the staged one stays staged.
  const src = JSON.parse(fs.readFileSync(path.join(vault, 'sources.json'), 'utf8'));
  assert.deepEqual(src.repos.filter(x => x.approved !== true).map(x => x.slug).sort(), ['fresh', 'gone']);
  assert.equal(src.repos.find(x => x.slug === 'fresh').status, 'staged');
  assert.equal(src.repos.find(x => x.slug === 'fresh').approved, false);
});

test('/wk sync under the Stop switch indexes nothing', () => {
  const { home, vault, wk, env } = sandbox();
  fs.writeFileSync(path.join(wk, 'KILL'), 'test\n');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'wk.mjs'), 'sync'], { cwd: home, env, encoding: 'utf8', timeout: 60000 });
  assert.match(r.stderr, /Stop switch is on/);
  assert.ok(!fs.existsSync(path.join(vault, 'index.json')));
});

// One writer for the vault's index.json: skill_vault._write_index_atomic (temp file plus rename).
// Every other file that names index.json may only read it (or call skill_vault.py to build it).
const SOURCE_DIRS = ['bin', 'core', 'panel/src', 'reprompt/scripts', 'reprompt/server', 'reprompt/ide-extension', 'reprompt/claude-code-plugin/bin'];
const WRITE_JS = /\b(writeFileSync|writeFile|appendFileSync|renameSync|copyFileSync|createWriteStream|rmSync|unlinkSync)\s*\(/;
const WRITE_PY = /\b(write_text|write_bytes|os\.replace|os\.rename|shutil\.copy\w*|shutil\.move|json\.dump|unlink)\s*\(|open\([^)]*['"][wa]b?\+?['"]/;

function sourceFiles() {
  const out = [];
  for (const d of SOURCE_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    (function walk(p) {
      for (const k of fs.readdirSync(p)) {
        if (k === 'node_modules' || k === 'dist' || k.startsWith('.')) continue;
        const f = path.join(p, k);
        const st = fs.statSync(f);
        if (st.isDirectory()) walk(f);
        else if (/\.(m?js|py)$/.test(k)) out.push(f);
      }
    })(abs);
  }
  return out;
}

// The names a file gives the index path: `X = ...index.json...`, plus skill_vault's helpers.
function indexNames(text) {
  const names = new Set(['_index_file()', 'INDEX_FILE']);
  for (const line of text.split('\n')) {
    if (!/index\.json/.test(line)) continue;
    const m = line.match(/(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=(?!=)/);
    if (m) names.add(m[1]);
  }
  for (const line of text.split('\n')) {
    const m = line.match(/([A-Za-z_$][\w$]*)\s*=\s*_index_file\(\)/);
    if (m) names.add(m[1]);
  }
  return [...names];
}

test('index.json has one writer: skill_vault._write_index_atomic, atomically', () => {
  const offenders = [];
  let writerSeen = false;
  for (const f of sourceFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    if (!/index\.json|_index_file\(\)|INDEX_FILE/.test(text)) continue;
    const py = f.endsWith('.py');
    const names = indexNames(text);
    const lines = text.split('\n');
    let inWriter = false;
    lines.forEach((line, i) => {
      if (py && /^def /.test(line)) inWriter = /^def _write_index_atomic\(/.test(line);
      if (inWriter) { writerSeen = true; return; }
      const writes = py ? WRITE_PY.test(line) : WRITE_JS.test(line);
      if (!writes) return;
      const hit = /index\.json/.test(line) || names.some(n => {
        const esc = n.replace(/[$()]/g, '\\$&');
        return new RegExp(`(^|[^\\w$.])${esc}(?![\\w$])`).test(line);
      });
      if (hit) offenders.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.ok(writerSeen, 'skill_vault.py still defines _write_index_atomic');
  assert.deepEqual(offenders, [], 'only _write_index_atomic may write index.json');
  const sv = fs.readFileSync(path.join(ROOT, 'reprompt', 'scripts', 'skill_vault.py'), 'utf8');
  const body = sv.slice(sv.indexOf('def _write_index_atomic('), sv.indexOf('\ndef ', sv.indexOf('def _write_index_atomic(') + 5));
  assert.match(body, /tempfile\.mkstemp/);
  assert.match(body, /os\.replace\(tmp_name, idx_file\)/);
});
