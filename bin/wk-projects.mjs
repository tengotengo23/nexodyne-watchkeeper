#!/usr/bin/env node
// wk-projects (P2-227): the list of projects a job may run in, ~/.wk/projects.json (or $WK_HOME).
//   wk-projects scan [--write] [--json] [--root <dir>]...   -> finds git repositories under ~/Projects and ~/Developer (two levels deep),
//                                                               and in each repository the top-level folders that are products of their own
//                                                               (a package.json, a README or an Xcode project). It writes the file on the first
//                                                               run, or with --write; otherwise it prints what it found and leaves the file alone.
//   wk-projects list [--json]                               -> the projects in the file
// Exit: 0 done, 2 bad input. Nothing here changes a repository: it reads the folders and asks git nothing (a .git entry is enough).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wkHome, writePrivate, readJsonFile, PROJECT_KEY } from './remote-lib.mjs';

export const projectsFile = () => path.join(wkHome(), 'projects.json');
const SKIP = new Set(['node_modules', '.git', 'build', 'dist', 'DerivedData', 'Pods', 'vendor', '.build', '.next', 'coverage', 'tmp']);
const tilde = p => { const h = os.homedir(); return p === h ? '~' : p.startsWith(h + '/') ? '~' + p.slice(h.length) : p; };
const expand = p => (typeof p === 'string' ? p.replace(/^~(?=\/|$)/, os.homedir()) : p);
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const exists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
const list = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)).map(e => e.name).sort(); } catch { return []; } };

export function keyOf(name, taken) {
  let k = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+$/, '').slice(0, 60) || 'project';
  if (!PROJECT_KEY.test(k)) k = 'project';
  let out = k, i = 2;
  while (taken.has(out)) out = `${k}-${i++}`;
  taken.add(out);
  return out;
}
// A product folder inside a repository: its own package.json, a README, or an Xcode project
function isProduct(dir) {
  let names; try { names = fs.readdirSync(dir); } catch { return false; }
  return names.some(n => n === 'package.json' || /^readme(\.[a-z]+)?$/i.test(n) || /\.(xcodeproj|xcworkspace)$/.test(n) || n === 'Package.swift');
}

export function scan(roots = [path.join(os.homedir(), 'Projects'), path.join(os.homedir(), 'Developer')]) {
  const repos = [];
  for (const r of roots) {
    if (!isDir(r)) continue;
    for (const a of list(r)) {
      const p1 = path.join(r, a);
      if (exists(path.join(p1, '.git'))) repos.push(p1);   // and a repository nested one level inside it is its own project
      for (const b of list(p1)) { const p2 = path.join(p1, b); if (exists(path.join(p2, '.git'))) repos.push(p2); }
    }
  }
  const taken = new Set(), projects = [];
  for (const repo of repos) {
    projects.push({ key: keyOf(path.basename(repo), taken), name: path.basename(repo), path: tilde(repo), kind: 'repo' });
    for (const f of list(repo)) {
      const dir = path.join(repo, f);
      if (exists(path.join(dir, '.git'))) continue;   // a nested repository is listed on its own when it is in range
      if (isProduct(dir)) projects.push({ key: keyOf(f, taken), name: `${path.basename(repo)}/${f}`, path: tilde(dir), kind: 'folder', repo: tilde(repo) });
    }
  }
  return projects;
}

// The file as jobs read it: absolute paths, valid keys only (accepts either `key` or `id`)
export function readProjects() {
  const j = readJsonFile(projectsFile(), null);
  if (!j || !Array.isArray(j.projects)) return { found: false, projects: [] };
  const keyOfEntry = p => (p && typeof p.key === 'string' && p.key) || (p && typeof p.id === 'string' && p.id) || '';
  const projects = j.projects.filter(p => p && PROJECT_KEY.test(keyOfEntry(p)) && typeof p.path === 'string')
    .map(p => {
      const key = keyOfEntry(p);
      return { key, name: String(p.name || key).slice(0, 80), path: path.resolve(expand(p.path)), kind: p.kind === 'folder' ? 'folder' : 'repo',
        ...(p.kind === 'folder' && typeof p.repo === 'string' ? { repo: path.resolve(expand(p.repo)) } : {}) };
    });
  return { found: true, projects };
}
export const findProject = key => readProjects().projects.find(p => p.key === key) || null;

function parse(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { cmd: 'help', write: false, json: false, roots: [] };
  const o = { cmd: argv[0] || '', write: false, json: false, roots: [] };
  for (let i = 1; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--write') o.write = true;
    else if (x === '--json') o.json = true;
    else if (x === '--root') { const v = argv[++i]; if (!v) throw Object.assign(new Error('--root needs a folder'), { code: 2 }); o.roots.push(path.resolve(expand(v))); }
    else throw Object.assign(new Error(`unknown option ${String(x).slice(0, 40)}`), { code: 2 });
  }
  return o;
}

export function main(argv, out = s => process.stdout.write(s + '\n')) {
  const o = parse(argv);
  if (o.cmd === 'help') {
    out('usage: wk-projects scan [--write] [--json] [--root <dir>]... | list [--json]');
    return 0;
  }
  if (o.cmd === 'scan') {
    const found = scan(o.roots.length ? o.roots : undefined), had = exists(projectsFile());
    const wrote = !had || o.write;
    if (wrote) writePrivate(projectsFile(), JSON.stringify({ projects: found }, null, 2) + '\n');
    if (o.json) out(JSON.stringify({ wrote, projects: found }));
    else {
      for (const p of found) out(`${p.key.padEnd(24)} ${p.kind.padEnd(6)} ${p.path}`);
      out(wrote ? `Wrote ${found.length} projects to ${tilde(projectsFile())}.` : `Found ${found.length} projects. ${tilde(projectsFile())} is already there: run with --write to replace it.`);
    }
    return 0;
  }
  if (o.cmd === 'list') {
    const r = readProjects();
    if (o.json) out(JSON.stringify(r));
    else if (!r.found) out('No projects file yet. Run: wk-projects scan');
    else for (const p of r.projects) out(`${p.key.padEnd(24)} ${p.kind.padEnd(6)} ${tilde(p.path)}`);
    return 0;
  }
  throw Object.assign(new Error('usage: wk-projects scan [--write] [--json] [--root <dir>]... | list [--json]'), { code: 2 });
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`wk-projects: ${e.message}\n`); process.exitCode = e.code === 2 ? 2 : 1; }
}
