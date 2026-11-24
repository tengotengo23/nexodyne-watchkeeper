// P2-272 Phase 4: the task splitter's pure parts in JS (twin of core/dag_orchestrator.py): fast triage, plan checks,
// waves, glob overlap and the evidence gate. Both read test/fixtures/dag-triage-vectors.json in their tests.
// No model call, no process, no file write here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VECTORS = path.join(HERE, '..', 'test', 'fixtures', 'dag-triage-vectors.json');
export const PROVIDERS = ['claude', 'gemini'];
export const CLAUDE_MODELS = ['sonnet', 'opus', 'fable', 'haiku'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const NODE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_NODES = 20;
const RESERVED = ['integration'];

// ---------------------------------------------------------------- fast triage (same rules as the Python)
const FILE_RE = /(?:^|[\s`'"(])([A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*\.(?:py|mjs|cjs|js|ts|tsx|jsx|json|md|css|html|sh|yml|yaml|toml|swift|kt|go|rs|rb|java|c|h|cpp|txt))(?![A-Za-z0-9_])/g;
const LIST_RE = /^\s*(?:\d+[.)]|[-*])\s+\S/;
const SEQ_RE = /\b(?:then|after that|afterwards|finally|end-to-end|step by step|followed by)\b/g;
const VERB_RE = /\b(add|build|create|implement|fix|refactor|rename|migrate|update|change|write|remove|delete|move|replace|wire|port|split|integrate|deploy|test|make|show)\b/g;
const AREAS = [
  ['ui', /\b(?:ui|frontend|front-end|panel|css|html|page|screen|webview)\b/],
  ['backend', /\b(?:server|backend|back-end|api|endpoint|route)\b/],
  ['db', /\b(?:database|db|schema|migration|sql|sqlite)\b/],
  ['tests', /\b(?:tests?|test suite)\b/],
  ['docs', /\b(?:docs|documentation|readme)\b/],
  ['cli', /\b(?:cli|command line|terminal)\b/],
];
const QWORDS = new Set(['what', 'why', 'how', 'where', 'when', 'who', 'which', 'is', 'are', 'can', 'could', 'does', 'do',
  'should', 'would', 'explain', 'whats']);

export function triage(prompt) {
  const text = String(prompt ?? '').trim();
  const low = text.toLowerCase();
  if (!low) return { route: 'single', reason: 'empty' };
  const words = low.split(/\s+/);
  const first = (words[0] || '').replace(/[^a-z']/g, '');
  const question = low.endsWith('?') || QWORDS.has(first);
  const files = new Set([...text.matchAll(FILE_RE)].map(m => m[1]));
  const items = text.split(/\r?\n/).filter(l => LIST_RE.test(l)).length;
  const seq = (low.match(SEQ_RE) || []).length;
  const verbs = new Set((low.match(VERB_RE) || [])).size;
  const areas = AREAS.filter(([, rx]) => rx.test(low)).length;
  if (question && items < 2) return { route: 'single', reason: 'question' };
  if (items >= 2 && verbs >= 1) return { route: 'plan', reason: 'list of steps' };
  if (files.size >= 2 && verbs >= 1) return { route: 'plan', reason: 'several files' };
  if (areas >= 2 && verbs >= 1) return { route: 'plan', reason: 'several areas' };
  if (seq >= 1 && verbs >= 2) return { route: 'plan', reason: 'several steps' };
  return { route: 'single', reason: files.size === 1 ? 'one file' : 'simple task' };
}

export function loadVectors(file = VECTORS) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).vectors;
}

// ---------------------------------------------------------------- globs (the reading of bin/lib.mjs globBody)
export function globBody(g) {
  let s = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { s += '(?:.*/)?'; i += 2; continue; }
      s += '.*'; i += 1; continue;
    }
    if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\\/-]/g, '\\$&');
  }
  return s;
}
export const ownedRe = g => new RegExp('^' + globBody(g) + '$');
// N8: the deny list ignores letter case (.ENV is denied like .env), as in core/dag_orchestrator.py and wk-task.
export const denyRe = g => new RegExp('(^|/)' + globBody(g).replace(/^\(\?:\.\*\/\)\?/, '') + '$', 'i');

const literalPrefix = g => { const m = /[*?[]/.exec(g); return m ? g.slice(0, m.index) : g; };
export function globsMayOverlap(a, b) {
  const pa = literalPrefix(a), pb = literalPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}
export const nodesMayOverlap = (x, y) => (x.ownedGlobs || []).some(a => (y.ownedGlobs || []).some(b => globsMayOverlap(a, b)));

// ---------------------------------------------------------------- plan checks
const badGlob = g => typeof g !== 'string' || !g.trim() || g.length > 200 || g.startsWith('/') || g.includes('\\')
  || g.includes('\n') || g.split('/').includes('..');

export function validatePlan(nodes) {
  const errs = [];
  if (!Array.isArray(nodes) || !nodes.length) return { ok: false, errors: ['The plan has no steps.'], nodes: [] };
  if (nodes.length > MAX_NODES) return { ok: false, errors: [`The plan has ${nodes.length} steps; the most is ${MAX_NODES}.`], nodes: [] };
  const out = [], ids = new Set();
  nodes.forEach((n, i) => {
    let where = `Step ${i + 1}`;
    if (!n || typeof n !== 'object' || Array.isArray(n)) { errs.push(`${where} is not an object.`); return; }
    const id = n.id;
    if (typeof id !== 'string' || !NODE_ID.test(id) || RESERVED.includes(id)) {
      errs.push(`${where} has a bad id (lower-case letters, digits and hyphens, at most 40).`); return;
    }
    where = `Step ${id}`;
    if (ids.has(id)) errs.push(`${where} appears twice.`);
    ids.add(id);
    if (typeof n.title !== 'string' || !n.title.trim() || n.title.length > 200) errs.push(`${where} needs a title of 1 to 200 characters.`);
    let deps = n.dependsOn ?? [];
    if (!Array.isArray(deps) || !deps.every(d => typeof d === 'string')) { errs.push(`${where}: dependsOn must be a list of step ids.`); deps = []; }
    if (!PROVIDERS.includes(n.provider)) errs.push(`${where}: provider must be claude or gemini.`);
    if (n.provider === 'claude' && !CLAUDE_MODELS.includes(n.model)) errs.push(`${where}: a Claude step's model must be one of ${CLAUDE_MODELS.join(', ')}.`);
    if (n.provider === 'gemini' && (typeof n.model !== 'string' || !n.model.trim() || n.model.length > 60)) errs.push(`${where}: a Gemini step needs a model name.`);
    if (!EFFORTS.includes(n.effort)) errs.push(`${where}: effort must be one of ${EFFORTS.join(', ')}.`);
    let globs = n.ownedGlobs;
    if (!Array.isArray(globs) || !globs.length || globs.length > 20 || globs.some(badGlob)) {
      errs.push(`${where}: ownedGlobs must list 1 to 20 relative paths or globs inside the repository.`); globs = [];
    }
    let contract = n.interfaceContract ?? '';
    if (typeof contract !== 'string' || contract.length > 2000) { errs.push(`${where}: interfaceContract must be text of at most 2000 characters.`); contract = ''; }
    const v = n.verifyCmd;
    if (typeof v !== 'string' || !v.trim() || v.length > 500 || /[\r\n]/.test(v)) errs.push(`${where}: verifyCmd must be one line of 1 to 500 characters.`);
    out.push({ id, title: String(n.title || '').trim(), dependsOn: [...new Set(deps)], provider: n.provider,
      model: String(n.model || '').trim(), effort: n.effort, ownedGlobs: globs.map(g => g.trim()),
      interfaceContract: contract, verifyCmd: String(v || '').trim() });
  });
  for (const n of out) for (const d of n.dependsOn) {
    if (d === n.id) errs.push(`Step ${n.id} depends on itself.`);
    else if (!ids.has(d)) errs.push(`Step ${n.id} depends on ${d}, which is not in the plan.`);
  }
  if (!errs.length) {
    const c = findCycle(out);
    if (c) errs.push('The steps wait for each other in a circle: ' + c.join(' -> ') + '.');
  }
  return { ok: !errs.length, errors: errs, nodes: errs.length ? [] : out };
}

export function findCycle(nodes) {
  const deps = new Map(nodes.map(n => [n.id, n.dependsOn || []]));
  const color = new Map([...deps.keys()].map(k => [k, 0]));
  const stack = [];
  const visit = u => {
    color.set(u, 1); stack.push(u);
    for (const v of deps.get(u) || []) {
      if (!color.has(v)) continue;
      if (color.get(v) === 1) return [...stack.slice(stack.indexOf(v)), v];
      if (color.get(v) === 0) { const c = visit(v); if (c) return c; }
    }
    stack.pop(); color.set(u, 2); return null;
  };
  for (const k of deps.keys()) if (color.get(k) === 0) { const c = visit(k); if (c) return c; }
  return null;
}

export function planWaves(nodes) {
  const by = new Map(nodes.map(n => [n.id, n]));
  const level = new Map();
  const lv = u => {
    if (!level.has(u)) level.set(u, 1 + Math.max(-1, ...by.get(u).dependsOn.map(lv)));
    return level.get(u);
  };
  nodes.forEach(n => lv(n.id));
  const waves = [];
  const top = Math.max(-1, ...level.values());
  for (let L = 0; L <= top; L++) {
    const subs = [];
    for (const n of nodes) {
      if (level.get(n.id) !== L) continue;
      const s = subs.find(s => !s.some(o => nodesMayOverlap(n, by.get(o))));
      if (s) s.push(n.id); else subs.push([n.id]);
    }
    waves.push(...subs);
  }
  return waves;
}

// ---------------------------------------------------------------- the evidence gate
export function gateCheck(changed, ownedGlobs, denyGlobs, step = '') {
  const who = step ? `Step ${step}` : 'The step';
  const owned = ownedGlobs.map(ownedRe), deny = denyGlobs.map(denyRe);
  const outside = [], denied = [], odd = [];
  for (const f of changed) {
    const p = String(f).replace(/\\/g, '/');
    if (!p || p.startsWith('/') || p.split('/').includes('..')) { odd.push(p); continue; }
    if (deny.some(r => r.test(p))) denied.push(p);
    if (!owned.some(r => r.test(p))) outside.push(p);
  }
  const reasons = [];
  if (odd.length) reasons.push(`${who} named files outside the repository: ${odd.slice(0, 10).join(', ')}.`);
  if (denied.length) reasons.push(`${who} changed protected files (gates.json deny list): ${denied.slice(0, 10).join(', ')}.`);
  if (outside.length) reasons.push(`${who} changed files outside its own files (${ownedGlobs.join(', ')}): ${outside.slice(0, 10).join(', ')}.`);
  return { ok: !reasons.length, outside, denied, odd, reason: reasons.join(' ') };
}

export function singleNode(task, verifyCmd = 'true', globs = null) {
  const title = (String(task || '').trim().split(/\r?\n/)[0] || 'Task').slice(0, 200) || 'Task';
  return [{ id: 'main-step', title, dependsOn: [], provider: 'claude', model: 'opus', effort: 'high',
    ownedGlobs: globs || ['**'], interfaceContract: '', verifyCmd }];
}
