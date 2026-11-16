// P2-227: wk-projects on a temp tree: repositories one and two levels down, a monorepo with product folders, the skip list.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-proj-')));
const WK = path.join(HOME, '.wk');
process.env.HOME = HOME; process.env.WK_HOME = WK;
const BIN = path.resolve('bin/wk-projects.mjs');
const P = await import('../bin/wk-projects.mjs');
const mk = (rel, files = []) => { const d = path.join(HOME, rel); fs.mkdirSync(d, { recursive: true }); for (const f of files) { const p = path.join(d, f); if (/\.(xcodeproj)$|^\.git$/.test(f)) fs.mkdirSync(p, { recursive: true }); else fs.writeFileSync(p, ''); } return d; };
mk('Projects/alpha', ['.git']);                                   // depth 1
mk('Projects/clients/beta', ['.git']);                            // depth 2
mk('Projects/clients/notes');                                     // not a repository
mk('Projects/deep/a/b', ['.git']);                                // depth 3: out of range
mk('Projects/mono', ['.git', 'README.md']);
mk('Projects/mono/shop', ['package.json']);
mk('Projects/mono/ios-app', ['App.xcodeproj']);
mk('Projects/mono/docs', ['readme.txt']);
mk('Projects/mono/data');                                         // no product marker
mk('Projects/mono/node_modules/x', ['package.json']);             // skipped
mk('Projects/mono/.hidden', ['package.json']);                    // skipped
mk('Projects/mono/vendored', ['.git', 'package.json']);           // a nested repository: not a folder of mono
mk('Developer/Alpha', ['.git']);                                  // same name: its key gets -2
mk('Developer/swiftkit', ['.git', 'Package.swift']);
const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: 'utf8', env: { ...process.env, HOME, WK_HOME: WK } });

test('scan finds repositories at depth 1 and 2, product folders, and gives unique keys with ~ paths', () => {
  const found = P.scan();
  const keys = Object.fromEntries(found.map(p => [p.key, p]));
  assert.deepEqual(found.map(p => p.key).sort(), ['alpha', 'alpha-2', 'beta', 'docs', 'ios-app', 'mono', 'shop', 'swiftkit', 'vendored'].sort());
  assert.deepEqual(keys.alpha, { key: 'alpha', name: 'alpha', path: '~/Projects/alpha', kind: 'repo' });
  assert.equal(keys['alpha-2'].path, '~/Developer/Alpha');
  assert.equal(keys.beta.path, '~/Projects/clients/beta');
  assert.deepEqual(keys.shop, { key: 'shop', name: 'mono/shop', path: '~/Projects/mono/shop', kind: 'folder', repo: '~/Projects/mono' });
  assert.equal(keys['ios-app'].kind, 'folder'); assert.equal(keys.docs.kind, 'folder');
  assert.equal(keys.vendored.kind, 'repo');   // depth 2 under Projects/mono
  assert.ok(!found.some(p => /node_modules|hidden|data|notes|\/b$/.test(p.path)));
  assert.ok(found.every(p => !p.path.includes(HOME)));
});

test('the file is written on the first scan only, or with --write; list reads it back', () => {
  const r = run('scan'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Wrote 9 projects to ~\/\.wk\/projects\.json/);
  const f = path.join(WK, 'projects.json'); assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const j = JSON.parse(fs.readFileSync(f, 'utf8')); assert.equal(j.projects.length, 9);
  // the owner edits the file: a second scan leaves it alone
  fs.writeFileSync(f, JSON.stringify({ projects: [j.projects.find(p => p.key === 'shop')] }));
  mk('Projects/gamma', ['.git']);
  const r2 = run('scan', '--json'); const o = JSON.parse(r2.stdout);
  assert.equal(o.wrote, false); assert.equal(o.projects.length, 10);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).projects.length, 1);
  const l = JSON.parse(run('list', '--json').stdout);
  assert.deepEqual(l, { found: true, projects: [{ key: 'shop', name: 'mono/shop', path: path.join(HOME, 'Projects/mono/shop'), kind: 'folder', repo: path.join(HOME, 'Projects/mono') }] });
  assert.deepEqual(P.findProject('shop').repo, path.join(HOME, 'Projects/mono')); assert.equal(P.findProject('alpha'), null);
  assert.match(run('scan', '--write').stdout, /Wrote 10 projects/);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).projects.length, 10);
  // --root limits the scan
  assert.deepEqual(JSON.parse(run('scan', '--json', '--root', path.join(HOME, 'Developer')).stdout).projects.map(p => p.key), ['alpha', 'swiftkit']);
});

test('bad keys in the file are dropped; bad options exit 2; keys are safe', () => {
  fs.writeFileSync(path.join(WK, 'projects.json'), JSON.stringify({ projects: [{ key: '../x', path: '/' }, { key: 'ok', path: '~/Projects/alpha' }, { key: 'n', path: 5 }] }));
  assert.deepEqual(P.readProjects().projects.map(p => p.key), ['ok']);
  assert.equal(run('scan', '--nope').status, 2); assert.equal(run('frob').status, 2);
  const taken = new Set();
  assert.equal(P.keyOf('My App!', taken), 'my-app'); assert.equal(P.keyOf('My App?', taken), 'my-app-2'); assert.equal(P.keyOf('___', taken), 'project');
  fs.rmSync(path.join(WK, 'projects.json'));
  assert.match(run('list').stdout, /No projects file yet/);
});
