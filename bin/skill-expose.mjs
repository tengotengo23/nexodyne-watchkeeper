// P2-272 (B): one exposure of skills for both IDEs, capped. P2-273: at most 20 (panel/src/skill-gate.js capSkills).
// The exposed set is the owner's own skills (index entries with slug "local-installed")
// plus single skills the owner exposes one by one (never whole repos), minus the ones unexposed.
// Links live in <WK_HOME>/skills-exposed/<name>; each is made only after core/sanitizer.py
// (skill_vault.py check-skill) passes the skill and its real path lies inside the vault or the
// owner's skill folders.
// Antigravity: one line in ~/.gemini/config/skills.txt holding the absolute path of the folder
//   (the app reads skills.txt as a list of folders of skill folders; evidence in the P2-272 return).
// Claude Code: links in ~/.claude/skills/<name>, listed in ~/.claude/skills/.wk-managed.json;
//   a taken name is skipped and reported; a skill an installed plugin already provides is skipped.
// Skills synced from the owner's Claude account (~/.claude/skills/synced/<id>/<name>) are Anthropic's:
//   Claude Code already loads them, so they never get a Claude link, and they reach Antigravity only
//   when their own licence file is Apache 2.0 or MIT. Some say "users may not extract these materials
//   from the Services"; some have no licence file. Those are withheld (P2-272, Phase 5).
// install-links backs up what it changes; uninstall-links restores it byte for byte.
// Every child process goes through the process-group runner (wk-watchdog runDetachedCommandSync).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { root } from './lib.mjs';
import { findPython } from './antigravity-lib.mjs';
import { runDetachedCommandSync } from './wk-watchdog.mjs';

const require = createRequire(import.meta.url);
const gate = require('../panel/src/skill-gate.js');

const STOPPED_MSG = 'Skill library stopped: the Stop switch (~/.wk/KILL) is on.';
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

export function paths(env = process.env) {
  const HOME = path.resolve(env.HOME || os.homedir());
  const wk = env.WK_HOME ? path.resolve(env.WK_HOME) : path.join(HOME, '.wk');
  const vault = env.REPROMPT_SKILL_VAULT_DIR ? path.resolve(env.REPROMPT_SKILL_VAULT_DIR) : path.join(HOME, '.gemini', 'skill-vault');
  const claudeSkills = path.join(HOME, '.claude', 'skills');
  const geminiConfig = path.join(HOME, '.gemini', 'config');
  return {
    HOME, wk, vault,
    exposedDir: path.join(wk, 'skills-exposed'),
    stateFile: path.join(wk, 'skills-exposed.json'),
    installFile: path.join(wk, 'skills-links.json'),
    backupsDir: path.join(wk, 'backups', 'skill-links'),
    claudeSkills,
    managedFile: path.join(claudeSkills, '.wk-managed.json'),
    geminiConfig,
    geminiSkills: path.join(geminiConfig, 'skills'),
    skillsTxt: path.join(geminiConfig, 'skills.txt'),
    pluginsFile: path.join(HOME, '.claude', 'plugins', 'installed_plugins.json'),
    repoSkills: path.join(env.WK_ROOT ? path.resolve(env.WK_ROOT) : root(), 'skills'),
  };
}

function readJson(f, fallback = null) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
function writeJsonAtomic(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, f);
}
const lexists = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const realOrNull = p => { try { return fs.realpathSync(p); } catch { return null; } };
const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);

// A skill folder's licence: 'open' (Apache 2.0 or MIT), 'restricted' (any other licence file) or 'none'.
const OPEN_LICENCE = /^\s*(?:Apache License\s+Version 2\.0\b|(?:The\s+)?MIT License\b)/i;
export function licenceOf(dir) {
  for (const f of ['LICENSE.txt', 'LICENSE', 'LICENSE.md']) {
    let head;
    try { head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 300); } catch { continue; }
    return OPEN_LICENCE.test(head) ? 'open' : 'restricted';
  }
  return 'none';
}
// Is this skill folder one that Claude Code syncs from the owner's Claude account?
function isSynced(P, dir) {
  const syn = realOrNull(path.join(P.claudeSkills, 'synced'));
  const real = realOrNull(dir);
  return !!(syn && real && inside(real, syn));
}
const WITHHELD_WHY = {
  restricted: "Anthropic's own licence keeps it inside Anthropic's services",
  none: 'it has no licence file',
};

// A link name: the skill's name, lower case, safe characters only.
export const linkName = s => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 80);

function loadState(P) {
  const s = readJson(P.stateFile, {}) || {};
  return { version: 1, extra: Array.isArray(s.extra) ? s.extra : [], hidden: Array.isArray(s.hidden) ? s.hidden : [] };
}

function allowedIndex(P) {
  const index = readJson(path.join(P.vault, 'index.json'), {}) || {};
  const sources = readJson(path.join(P.vault, 'sources.json'), {}) || {};
  return gate.allowedSkills(index, sources);
}

// The exposed set: defaults (local-installed) minus hidden, plus extras; extras still pass the gate today.
// A synced skill without an open licence is withheld: listed in `withheld`, never exposed.
function exposure(env) {
  const P = paths(env);
  const st = loadState(P);
  const allowed = allowedIndex(P);
  const byId = new Map(allowed.map(s => [s.id, s]));
  const out = [], withheld = [], seen = new Set();
  const add = (s, origin) => {
    if (!s || seen.has(s.id) || st.hidden.includes(s.id)) return;
    seen.add(s.id);
    const dir = path.dirname(s.path);
    const synced = isSynced(P, dir);
    if (synced) {
      const lic = licenceOf(realOrNull(dir) || dir);
      if (lic !== 'open') { withheld.push({ id: s.id, name: s.name, link: linkName(s.name), licence: lic, reason: WITHHELD_WHY[lic] }); return; }
    }
    out.push({ id: s.id, name: s.name, link: linkName(s.name), slug: s.slug, repo: s.repo, dir, origin, ...(synced ? { synced: true } : {}) });
  };
  for (const s of allowed) if (s.slug === gate.LOCAL_SLUG) add(s, 'own');
  for (const id of st.extra) add(byId.get(id), 'exposed');
  // P2-273: at most gate.MAX_SKILLS (20), the highest-signal first (panel/src/skill-gate.js capSkills)
  const { kept, over } = gate.capSkills(out);
  return { out: kept, withheld, capped: over };
}
export function exposedSet(env = process.env) { return exposure(env).out; }

// A slug that is safe as one folder name (the same shape the Python side writes).
export const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Only approved sources' own folders (vault/repos/<slug>) and the owner's skill folders.
// Staged and rejected repos in the vault are never an allowed root.
export function allowedRoots(P) {
  const sources = readJson(path.join(P.vault, 'sources.json'), {}) || {};
  const repos = gate.approvedSources(sources)
    .map(r => r.slug)
    .filter(slug => typeof slug === 'string' && SAFE_SLUG.test(slug) && slug !== gate.LOCAL_SLUG && !/^\.+$/.test(slug))
    .map(slug => path.join(P.vault, 'repos', slug));
  return [...repos, P.claudeSkills, P.geminiSkills, P.repoSkills].map(realOrNull).filter(Boolean);
}

const WALK_MAX = 20000;
// Every link inside the skill folder must resolve inside it; a link to anywhere else would be
// readable through the exposed link. Returns null when all is well, else the reason.
function linkLeavesFolder(real) {
  const stack = [real];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let kids;
    try { kids = fs.readdirSync(dir); } catch { return `a folder inside it could not be read (${path.relative(real, dir) || '.'})`; }
    for (const k of kids) {
      if (++seen > WALK_MAX) return `it holds more than ${WALK_MAX} files and folders, too many to check`;
      const at = path.join(dir, k);
      let st;
      try { st = fs.lstatSync(at); } catch { continue; }
      if (st.isSymbolicLink()) {
        const r = realOrNull(at);
        if (!r || !inside(r, real)) return `the link ${path.relative(real, at)} leads outside the skill folder`;
      } else if (st.isDirectory()) stack.push(at);
    }
  }
  return null;
}

function runCheck(dir, env) {
  const py = findPython({ env });
  const script = path.join(root(), 'reprompt', 'scripts', 'skill_vault.py');
  const r = runDetachedCommandSync([py, script, 'check-skill', dir, '--json'].map(shq).join(' '),
    { env: { ...env, PYTHONDONTWRITEBYTECODE: '1' }, timeoutMs: 60000, idleMs: 60000, cwd: root() });
  let j = null;
  try { j = JSON.parse(String(r.stdout || '').trim()); } catch {}
  if (j && j.ok === true) return { ok: true };
  if (j && j.stopped) return { ok: false, reason: 'the Stop switch is on' };
  return { ok: false, reason: (j && (j.reason || j.error)) || (r.timedOut ? 'the check timed out' : `the check failed (exit ${r.status})`) };
}

// The two checks every link must pass: the real path lies in an allowed folder, and the sanitizer passes it.
export function vetSkill(dir, env = process.env) {
  const P = paths(env);
  const real = realOrNull(dir);
  if (!real) return { ok: false, reason: 'the skill folder is missing' };
  if (!allowedRoots(P).some(r => inside(real, r))) return { ok: false, reason: 'its real path lies outside the vault and the skill folders' };
  const skillMd = realOrNull(path.join(real, 'SKILL.md'));
  if (!skillMd || !inside(skillMd, real)) return { ok: false, reason: 'SKILL.md is missing or leads outside the skill folder' };
  const out = linkLeavesFolder(real);
  if (out) return { ok: false, reason: out };
  const c = runCheck(real, env);
  return c.ok ? { ok: true, real } : { ok: false, reason: `the sanitizer refused it: ${c.reason}` };
}

function pluginSkillNames(P) {
  const d = readJson(P.pluginsFile, {}) || {};
  const names = new Map();
  for (const [plugin, recs] of Object.entries(d.plugins || {})) {
    for (const rec of Array.isArray(recs) ? recs : [recs]) {
      const dir = rec && rec.installPath && path.join(rec.installPath, 'skills');
      let kids = [];
      try { kids = fs.readdirSync(dir); } catch {}
      for (const k of kids) if (fs.existsSync(path.join(dir, k, 'SKILL.md'))) names.set(k, plugin);
    }
  }
  return names;
}

// Bring <wk>/skills-exposed in line with the set: make vetted links, drop stale links (links only).
function materialize(P, env) {
  fs.mkdirSync(P.exposedDir, { recursive: true });
  const linked = [], refused = [], names = new Set();
  for (const s of exposedSet(env)) {
    if (!s.link || names.has(s.link)) { refused.push({ id: s.id, reason: `the name "${s.link}" is already used by another exposed skill` }); continue; }
    const v = vetSkill(s.dir, env);
    if (!v.ok) { refused.push({ id: s.id, reason: v.reason }); continue; }
    names.add(s.link);
    const at = path.join(P.exposedDir, s.link);
    if (isLink(at) && fs.readlinkSync(at) === v.real) { linked.push({ ...s, real: v.real }); continue; }
    if (isLink(at)) fs.unlinkSync(at);
    else if (lexists(at)) { refused.push({ id: s.id, reason: `${at} is not a link; left alone` }); names.delete(s.link); continue; }
    fs.symlinkSync(v.real, at);
    linked.push({ ...s, real: v.real });
  }
  for (const k of fs.readdirSync(P.exposedDir)) {
    const at = path.join(P.exposedDir, k);
    if (!names.has(k) && isLink(at)) fs.unlinkSync(at);
  }
  return { linked, refused };
}

// Claude Code links: add and remove only names in .wk-managed.json.
function syncClaudeLinks(P, linked) {
  const managed = new Set((readJson(P.managedFile, {}) || {}).managed || []);
  const plugins = pluginSkillNames(P);
  const want = new Map(linked.map(s => [s.link, path.join(P.exposedDir, s.link)]));
  // Claude Code already loads skills synced from the owner's Claude account: never a second link.
  const synced = new Set(linked.filter(s => s.synced).map(s => s.link));
  const skipped = [];
  fs.mkdirSync(P.claudeSkills, { recursive: true });
  // A managed name whose link no longer points to our folder was replaced by the owner: keep the
  // link, stop managing the name.
  const ours = name => { const at = path.join(P.claudeSkills, name); return isLink(at) && fs.readlinkSync(at) === path.join(P.exposedDir, name); };
  for (const name of [...managed]) {
    const at = path.join(P.claudeSkills, name);
    if (lexists(at) && !ours(name)) { managed.delete(name); continue; }
    if (!want.has(name) || plugins.has(name) || synced.has(name)) {
      if (isLink(at)) fs.unlinkSync(at);
      managed.delete(name);
    }
  }
  for (const [name, target] of want) {
    const at = path.join(P.claudeSkills, name);
    if (plugins.has(name)) { skipped.push({ name, reason: `the plugin ${plugins.get(name)} already provides it` }); continue; }
    if (synced.has(name)) { skipped.push({ name, reason: 'Claude Code already loads it (synced from your Claude account)' }); continue; }
    if (managed.has(name)) {
      if (isLink(at) && fs.readlinkSync(at) === target) continue;
    } else if (lexists(at)) {
      const same = realOrNull(at) && realOrNull(at) === realOrNull(target);
      skipped.push({ name, reason: same ? 'Claude Code already sees it there' : 'the name is taken' });
      continue;
    }
    fs.symlinkSync(target, at);
    managed.add(name);
  }
  writeJsonAtomic(P.managedFile, { version: 1, by: 'watchkeeper', note: 'Links Watchkeeper made; it adds and removes only these.', managed: [...managed].sort() });
  return { managed: [...managed].sort(), skipped };
}

const installed = P => readJson(P.installFile, null);

function refreshIfInstalled(P, env) {
  if (!installed(P)) return null;
  const m = materialize(P, env);
  const c = syncClaudeLinks(P, m.linked);
  return { linked: m.linked.length, refused: m.refused, claude: c };
}

// After a source is approved, rejected or synced: bring the links in line with the gate.
// Never throws; returns null when links are not installed, { error } when the refresh failed.
export function refresh(env = process.env) {
  try { return refreshIfInstalled(paths(env), env); } catch (e) { return { error: e.message }; }
}

function findSkill(P, arg) {
  const allowed = allowedIndex(P);
  const exact = allowed.filter(s => s.id === arg);
  const hits = exact.length ? exact : allowed.filter(s => s.name === arg || linkName(s.name) === linkName(arg));
  if (hits.length === 1) return { skill: hits[0] };
  if (hits.length > 1) return { error: `"${arg}" matches ${hits.length} skills; use the full id: ${hits.slice(0, 5).map(s => s.id).join(', ')}` };
  const index = readJson(path.join(P.vault, 'index.json'), {}) || {};
  const any = (index.skills || []).some(s => s && (s.id === arg || s.name === arg));
  return { error: any ? `"${arg}" comes from a source that is not approved; approve the source first` : `no skill "${arg}" in the library` };
}

export function exposeSkill(arg, env = process.env) {
  const P = paths(env);
  if (!arg) return { ok: false, code: 2, message: 'usage: wk-skill-sync expose <skill name or id>' };
  const f = findSkill(P, arg);
  if (f.error) return { ok: false, code: 1, message: f.error };
  const s = f.skill;
  const sdir = path.dirname(s.path);
  if (isSynced(P, sdir)) {
    const lic = licenceOf(realOrNull(sdir) || sdir);
    if (lic !== 'open') return { ok: false, code: 1, message: `not exposed: ${s.id}: it is synced from your Claude account and ${WITHHELD_WHY[lic]}` };
  }
  const v = vetSkill(sdir, env);
  if (!v.ok) return { ok: false, code: 1, message: `not exposed: ${s.id}: ${v.reason}` };
  const now = exposure(env).out;
  if (!now.some(x => x.id === s.id) && now.length >= gate.MAX_SKILLS) {
    return { ok: false, code: 1, message: `not exposed: ${s.id}: ${gate.MAX_SKILLS} skills are exposed already (the cap); unexpose one first` };
  }
  const st = loadState(P);
  st.hidden = st.hidden.filter(id => id !== s.id);
  if (s.slug !== gate.LOCAL_SLUG && !st.extra.includes(s.id)) st.extra.push(s.id);
  writeJsonAtomic(P.stateFile, st);
  const live = refreshIfInstalled(P, env);
  return { ok: true, code: 0, id: s.id, link: linkName(s.name), live: !!live, message: `exposed ${s.id}${live ? '' : ' (links appear after install-links)'}` };
}

export function unexposeSkill(arg, env = process.env) {
  const P = paths(env);
  if (!arg) return { ok: false, code: 2, message: 'usage: wk-skill-sync unexpose <skill name or id>' };
  const cur = exposedSet(env);
  const hit = cur.find(s => s.id === arg) || cur.find(s => s.name === arg || s.link === linkName(arg));
  if (!hit) return { ok: false, code: 1, message: `"${arg}" is not exposed` };
  const st = loadState(P);
  st.extra = st.extra.filter(id => id !== hit.id);
  if (hit.origin === 'own' && !st.hidden.includes(hit.id)) st.hidden.push(hit.id);
  writeJsonAtomic(P.stateFile, st);
  const live = refreshIfInstalled(P, env);
  return { ok: true, code: 0, id: hit.id, live: !!live, message: `unexposed ${hit.id}` };
}

export function listExposed(env = process.env) {
  const P = paths(env);
  const { out: set, withheld, capped } = exposure(env);
  const inst = installed(P);
  const lines = set.map(s => `  ${s.link}  ${s.id}${s.origin === 'own' ? '' : '  (exposed by hand)'}${s.synced ? '  (Antigravity only: Claude Code already loads it)' : ''}`);
  const held = withheld.length
    ? [`${withheld.length} withheld (synced from your Claude account, no open licence): ${withheld.map(w => w.link).join(', ')}`] : [];
  if (capped.length) held.push(`${capped.length} left out by the ${gate.MAX_SKILLS}-skill cap (unexpose one to make room): ${capped.map(c => c.link).join(', ')}`);
  return {
    ok: true, code: 0, count: set.length, max: gate.MAX_SKILLS, installed: !!inst, exposed: set, withheld, capped,
    message: [`${set.length} exposed${inst ? '' : ' (links not installed)'}`, ...lines, ...held].join('\n').trimEnd(),
  };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

export function installLinks(env = process.env) {
  const P = paths(env);
  const prior = installed(P);
  if (prior) {
    const r = refreshIfInstalled(P, env);
    return { ok: true, code: 0, already: true, ...r, message: `links refreshed: ${r.linked} exposed, ${r.refused.length} refused, ${r.claude.skipped.length} skipped in Claude Code` };
  }
  const bdir = path.join(P.backupsDir, stamp() + '-' + process.pid);
  fs.mkdirSync(bdir, { recursive: true });
  const dirs = [P.wk, P.exposedDir, path.join(P.HOME, '.claude'), P.claudeSkills, path.join(P.HOME, '.gemini'), P.geminiConfig];
  const createdDirs = dirs.filter(d => !lexists(d));
  const fileRec = (f, key) => {
    if (!lexists(f)) return { path: f, existed: false };
    const b = path.join(bdir, key);
    fs.copyFileSync(f, b);
    return { path: f, existed: true, backup: b, sha256: sha(fs.readFileSync(f)) };
  };
  const manifest = {
    version: 1, made: new Date().toISOString(), backup_dir: bdir, created_dirs: createdDirs,
    skills_txt: fileRec(P.skillsTxt, 'skills.txt'), managed_json: fileRec(P.managedFile, 'wk-managed.json'),
  };
  writeJsonAtomic(path.join(bdir, 'manifest.json'), manifest);
  writeJsonAtomic(P.installFile, manifest);

  const m = materialize(P, env);
  // Antigravity: one search-path line, the absolute folder (never "~").
  fs.mkdirSync(P.geminiConfig, { recursive: true });
  const before = lexists(P.skillsTxt) ? fs.readFileSync(P.skillsTxt, 'utf8') : '';
  const has = before.split(/\r?\n/).some(l => l.trim() === P.exposedDir);
  if (!has) fs.writeFileSync(P.skillsTxt, before + (before && !before.endsWith('\n') ? '\n' : '') + P.exposedDir + '\n');
  manifest.skills_txt.after_sha256 = sha(fs.readFileSync(P.skillsTxt));
  const c = syncClaudeLinks(P, m.linked);
  manifest.managed_json.after_sha256 = sha(fs.readFileSync(P.managedFile));
  writeJsonAtomic(path.join(bdir, 'manifest.json'), manifest);
  writeJsonAtomic(P.installFile, manifest);
  return {
    ok: true, code: 0, linked: m.linked.length, refused: m.refused, claude: c, backup_dir: bdir,
    message: [`installed: ${m.linked.length} exposed in ${P.exposedDir}`, `Antigravity: ${P.skillsTxt}`,
      `Claude Code: ${c.managed.length} links in ${P.claudeSkills}`,
      ...m.refused.map(x => `  refused ${x.id}: ${x.reason}`), ...c.skipped.map(x => `  skipped ${x.name}: ${x.reason}`),
      `backup: ${bdir}`].join('\n'),
  };
}

export function uninstallLinks(env = process.env) {
  const P = paths(env);
  const man = installed(P);
  if (!man) return { ok: true, code: 0, already: true, message: 'links not installed; nothing to undo' };
  const notes = [];
  // Claude Code: remove only managed links that point into our folder.
  const managed = (readJson(P.managedFile, {}) || {}).managed || [];
  for (const name of managed) {
    const at = path.join(P.claudeSkills, name);
    if (isLink(at) && inside(path.resolve(P.claudeSkills, fs.readlinkSync(at)), P.exposedDir)) fs.unlinkSync(at);
  }
  const restore = (rec, ourLine) => {
    if (!lexists(rec.path)) { if (rec.existed) fs.copyFileSync(rec.backup, rec.path); return; }
    const nowSha = sha(fs.readFileSync(rec.path));
    if (!rec.after_sha256 || nowSha === rec.after_sha256) {
      if (rec.existed) fs.copyFileSync(rec.backup, rec.path); else fs.unlinkSync(rec.path);
    } else if (ourLine) {
      // Changed since install by someone else: take out only our line.
      const kept = fs.readFileSync(rec.path, 'utf8').split('\n').filter(l => l.trim() !== ourLine).join('\n');
      fs.writeFileSync(rec.path, kept);
      notes.push(`${rec.path} changed since install; removed only the Watchkeeper line`);
    } else {
      if (rec.existed) fs.copyFileSync(rec.backup, rec.path); else fs.unlinkSync(rec.path);
      notes.push(`${rec.path} changed since install; restored the backup`);
    }
  };
  restore(man.managed_json, null);
  restore(man.skills_txt, P.exposedDir);
  // Our own link folder: links only.
  if (lexists(P.exposedDir)) for (const k of fs.readdirSync(P.exposedDir)) { const at = path.join(P.exposedDir, k); if (isLink(at)) fs.unlinkSync(at); }
  fs.unlinkSync(P.installFile);
  for (const d of [...(man.created_dirs || [])].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(d); } catch { if (lexists(d)) notes.push(`${d} kept (not empty)`); }
  }
  return { ok: true, code: 0, backup_dir: man.backup_dir, notes, message: ['links removed and files restored', ...notes, `backup kept: ${man.backup_dir}`].join('\n') };
}

export function cli(cmd, arg, { stopped = false, env = process.env } = {}) {
  if (stopped) return { ok: true, code: 0, stopped: true, reason: 'stop_switch', message: STOPPED_MSG };
  try {
    if (cmd === 'expose') return exposeSkill(arg, env);
    if (cmd === 'unexpose') return unexposeSkill(arg, env);
    if (cmd === 'exposed') return listExposed(env);
    if (cmd === 'install-links') return installLinks(env);
    if (cmd === 'uninstall-links') return uninstallLinks(env);
    return { ok: false, code: 2, message: `unknown command ${cmd}` };
  } catch (e) {
    return { ok: false, code: 1, message: `wk-skill-sync ${cmd}: ${e.message}` };
  }
}
