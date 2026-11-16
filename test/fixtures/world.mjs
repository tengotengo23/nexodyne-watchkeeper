// Shared helper for the steward tests (P2-187). It builds a disposable world: a home folder, a Claude home, a state folder,
// a few small git projects, a projects file, an owner config and an empty ledger, all inside one temp folder that is removed afterwards.
// Nothing here touches the real ~/.wk or ~/.claude. The `claude` command is the fake in this folder (WK_CLAUDE).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const CLI = path.join(ROOT, 'bin', 'wk-steward.mjs');
export const FAKE = path.join(HERE, 'fake-claude.mjs');
export const HOUR = 36e5, DAY = 24 * HOUR;
// The test week ends Mon 9 Nov 2026 02:00Z: the reset time a real call reported on 8 Nov (1794189600). It fits the anchor in config/steward.json.
export const WEEK_END_S = 1794189600;
export const WEEK_START = WEEK_END_S * 1000 - 168 * HOUR;
export const NOW0 = WEEK_START + 84 * HOUR;       // half way through the week: the straight line is at 50%
export const iso = ms => new Date(ms).toISOString();

// The pace numbers the steward tests were written against (P2-187: ceiling 92%, landing 99%, last stretch 6 h). The shipped numbers changed on 11 Nov 2026 (Q90:
// ceiling 80%, landing 98%, last stretch 24 h; config/steward.json), so every test world starts from these old ones through its owner file, unless the test
// names its own. The shipped numbers themselves are pinned by the test "shipped pace numbers" in steward.unit.test.mjs and by test/ledger.pace.test.mjs.
export const OLD_PACE = { ceiling: 0.92, landTo: 0.99, lastHours: 6 };
export const withOldPace = cfg => ({ ...cfg, pace: { ...OLD_PACE, ...(cfg && cfg.pace) } });

const made = [];
export function cleanup() { for (const d of made.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } }

const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'], WEIGHTS = [3, 2, 1, 1, 1, 1];
const cap = s => s[0].toUpperCase() + s.slice(1);

// git with fixed dates: both commits are 3 days before the test clock, so the brief always says "3 days ago"
function gitIn(w, dir, args) {
  const when = `${Math.floor((w.now0 - 3 * DAY) / 1000)} +0000`;
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
    { cwd: dir, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: w.home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
}
function makeProject(w, spec) {
  const dir = path.join(w.dir, 'projects', spec.id);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${spec.name}\n\nA small project made for the steward tests.\n`);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: spec.id, version: '1.0.0', scripts: { test: 'node --test', build: 'echo build' } }, null, 1) + '\n');
  gitIn(w, dir, ['init', '-q']); gitIn(w, dir, ['add', '-A']); gitIn(w, dir, ['commit', '-q', '-m', 'Start the project']);
  // the marker is built from parts so this fixture is not counted when the steward visits the Watchkeeper repository itself
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), '// ' + 'TO' + 'DO: handle the empty list\nexport const add = (a, b) => a + b;\n');
  gitIn(w, dir, ['add', '-A']); gitIn(w, dir, ['commit', '-q', '-m', 'Add the first function']);
  return dir;
}

// projects: a number (alpha 3, beta 2, gamma 1, ...) or a list of ids / specs {id, weight, name, kind, goal, audience, number, notes, paused, path}
export function mkWorld({ projects = 3, config = {}, now = NOW0, oldPace = true } = {}) {   // oldPace: false = the owner file holds exactly `config` (the shipped pace numbers apply)
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-steward-test-')));   // realpath: macOS /var is a symlink
  made.push(dir);
  const w = { dir, now, now0: now, home: path.join(dir, 'home'), claudehome: path.join(dir, 'claudehome'), state: path.join(dir, 'state'), ledger: path.join(dir, 'ledger.jsonl'),
    ownerConfig: path.join(dir, 'owner-steward.json'), projectsFile: path.join(dir, 'projects.json'), fakeLog: path.join(dir, 'fake.log'),
    keyFile: path.join(dir, 'no-such-key.txt'), utilFile: path.join(dir, 'util.txt'), specs: [] };
  for (const d of [w.home, w.claudehome, w.state, path.join(dir, 'projects')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(w.ledger, '');
  const list = typeof projects === 'number' ? NAMES.slice(0, projects).map((id, i) => ({ id, weight: WEIGHTS[i] })) : projects.map(p => typeof p === 'string' ? { id: p } : p);
  for (const p of list) {
    const spec = { name: cap(p.id), kind: 'site', goal: 'Help a beginner finish the first lesson in one short visit', audience: 'People who are new to the subject', number: 'Visitors who come back the next week', weight: 1, ...p };
    if (!spec.path) spec.path = makeProject(w, spec);
    w.specs.push(spec);
  }
  fs.writeFileSync(w.projectsFile, JSON.stringify({ projects: w.specs }, null, 1));
  fs.writeFileSync(w.ownerConfig, JSON.stringify(oldPace ? withOldPace(config) : config, null, 1));
  return w;
}
export const setConfig = (w, obj) => fs.writeFileSync(w.ownerConfig, JSON.stringify(obj, null, 1));
export function editProjects(w, fn) { const j = JSON.parse(fs.readFileSync(w.projectsFile, 'utf8')); fn(j.projects); fs.writeFileSync(w.projectsFile, JSON.stringify(j, null, 1)); }

// A clean environment for the steward and the fake claude: no ANTHROPIC_* variables unless a test passes them in `extra`.
export function env(w, extra = {}) {
  const e = { PATH: process.env.PATH, HOME: w.home, TMPDIR: os.tmpdir(), WK_POLICY_SHA256: '', WK_STEWARD_DIR: w.state, WK_STEWARD_CONFIG: w.ownerConfig, WK_PROJECTS: w.projectsFile,
    WK_LEDGER: w.ledger, WK_NOW: iso(w.now), WK_CLAUDE: FAKE, WK_CLAUDE_HOME: w.claudehome, WK_API_KEY_FILE: w.keyFile, FAKE_LOG: w.fakeLog, CLAUDE_PROJECT_DIR: w.dir, ...extra };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
}

// run the command line and wait: { code, signal, out, err, json }
export function run(w, args, extra = {}, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: env(w, extra), encoding: 'utf8', timeout: opts.timeout || 60000, cwd: w.dir, input: '' });
  let json; if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch {} }
  return { code: r.status, signal: r.signal, out: r.stdout, err: r.stderr, json };
}
// start it and keep going: { p, out, err (getters), done: Promise<{code, signal, out, err}> }
export function start(w, args, extra = {}) {
  const p = spawn(process.execPath, [CLI, ...args], { env: env(w, extra), cwd: w.dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
  const done = new Promise(res => p.on('close', (code, signal) => res({ code, signal, out, err })));
  return { p, get out() { return out; }, get err() { return err; }, done };
}

export function readLines(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
export const events = (w, type) => readLines(path.join(w.state, 'events.jsonl')).filter(e => !type || e.type === type);
export const calls = w => readLines(w.fakeLog);
export const ledger = w => readLines(w.ledger);
export const stateFile = (w, name) => { try { return JSON.parse(fs.readFileSync(path.join(w.state, name), 'utf8')); } catch { return null; } };
export async function waitFor(fn, ms = 10000, step = 50) { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, step)); } }
export const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// the weekly meter the way the steward stores it (state/meter.json), `ageMin` minutes old
export function setMeter(w, { util = 0.4, ageMin = 1, reset = WEEK_END_S, five = null, status } = {}) {
  const m = { fetchedAt: iso(w.now - ageMin * 60000), utilization: util, resetsAt: reset, status: status ?? (util >= 0.75 ? 'allowed_warning' : 'allowed'),
    fiveHour: five === null ? null : { utilization: five, resetsAt: Math.floor(w.now / 1000) + 3 * 3600, status: 'allowed' }, source: 'call' };
  fs.writeFileSync(path.join(w.state, 'meter.json'), JSON.stringify(m));
  return m;
}
export const setUtil = (w, v) => fs.writeFileSync(w.utilFile, String(v));
// "the owner is working": a Claude session file written `ageMin` minutes before the test clock
export function touchOwner(w, ageMin) {
  const d = path.join(w.claudehome, 'projects', 'p'); fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'session.jsonl'); fs.writeFileSync(f, '{}\n');
  const t = new Date(w.now - ageMin * 60000); fs.utimesSync(f, t, t);
  return f;
}
