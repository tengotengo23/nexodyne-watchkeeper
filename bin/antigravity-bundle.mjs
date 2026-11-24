// Builds the self-contained Watchkeeper plugin for the Antigravity Marketplace and the GitHub release (P2-275).
// The plugin that `wk-antigravity install` copies points at this checkout by absolute paths. The bundle instead carries
// what it runs: runtime/ is this checkout's tracked files in the same layout (no tests, docs or panel), hooks use paths
// relative to the plugin folder (Antigravity runs plugin hooks there), mcp_config.json uses ${PLUGIN_ROOT} and
// ${PLUGIN_DATA}, and bin/ holds the tools the skills name (Antigravity lets the agent run a plugin's bin/ tools by name).
// Build it from the public tree only: the release runs it in the public mirror. Plain file copies; nothing here runs agy.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from './lib.mjs';

export const PLUGIN = 'watchkeeper';
// The bin/ tools: name -> [runtime, path inside runtime/]
export const TOOLS = {
  'wk': ['node', 'bin/wk.mjs'],
  'wk-status': ['node', 'bin/wk-status.mjs'],
  'wk-task': ['node', 'bin/wk-task.mjs'],
  'wk-suggest': ['node', 'bin/wk-suggest.mjs'],
  'wk-takeover': ['node', 'bin/wk-takeover.mjs'],
  'wk-ask-claude': ['node', 'bin/wk-ask-claude.mjs'],
  'wk-skill-sync': ['node', 'bin/wk-skill-sync.mjs'],
  'wk-skill-vault': ['python', 'reprompt/scripts/skill_vault.py'],
  'wk-orchestrate': ['python', 'reprompt/scripts/orchestrate.py'],
};
// Tracked files that stay out of runtime/: tests, docs, the panel extension, release files, and the plugin source itself.
// panel/src stays: bin/ scripts load its shared lists (legal-words.js, skill-gate.js, data.js) with createRequire.
// The developer's release tools stay out: scripts/ is private, and wk-sign signs releases in the private repository only.
export const RUNTIME_SKIP = [/^(test|tests|docs|public|release|scripts|\.github)\//, /^bin\/wk-sign\.mjs$/, /^panel\/(?!src\/)/, /^reprompt\/tests\//, /^antigravity\//, /(^|\/)__pycache__\//, /\.pyc$/];
export const INSTALLED_AT = `~/.gemini/config/plugins/${PLUGIN}`;

const SRC_DIR = `antigravity/plugins/${PLUGIN}`, EXTRA_DIR = 'antigravity/bundle';
const PLACEHOLDER = /\{\{[A-Z_]+\}\}/;

// "{{NODE}}" "{{WK_BIN_DIR}}/x.mjs" args  ->  ./libexec/wk-run node runtime/bin/x.mjs args
const HOOK_CMD = /^"\{\{(NODE|PYTHON)\}\}" "\{\{(WK_BIN_DIR|WK_REPROMPT_DIR)\}\}\/([A-Za-z0-9_./-]+)"(.*)$/s;
export function hookCommand(c) {
  const m = HOOK_CMD.exec(c);
  if (!m) throw new Error(`hooks.json: no self-contained form for: ${c}`);
  return `./libexec/wk-run ${m[1] === 'NODE' ? 'node' : 'python'} runtime/${m[2] === 'WK_BIN_DIR' ? 'bin' : 'reprompt'}/${m[3]}${m[4]}`;
}
export function renderHooks(json) {
  const walk = v => Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'command' && typeof x === 'string' ? hookCommand(x) : walk(x)]))
    : v;
  return walk(json);
}

// mcp_config.json: no shell and only ${PLUGIN_ROOT} / ${PLUGIN_DATA} expand, so the launcher runs through sh.
export function renderMcp(json) {
  const out = JSON.parse(JSON.stringify(json));
  for (const [name, s] of Object.entries(out.mcpServers || {})) {
    const kind = { '{{NODE}}': 'node', '{{PYTHON}}': 'python' }[s.command];
    if (!kind) throw new Error(`mcp_config.json: server ${name} has no self-contained form`);
    s.command = 'sh';
    s.args = ['${PLUGIN_ROOT}/libexec/wk-run', kind, ...(s.args || []).map(a => String(a)
      .split('{{WK_REPROMPT_DIR}}').join('${PLUGIN_ROOT}/runtime/reprompt')
      .split('{{WK_BIN_DIR}}').join('${PLUGIN_ROOT}/runtime/bin'))];
  }
  return out;
}

// Skills and rules: "{{NODE}}" "{{WK_BIN_DIR}}/wk-task.mjs"  ->  wk-task (a bin/ tool)
const MD_CMD = /"\{\{(NODE|PYTHON)\}\}" "\{\{(WK_BIN_DIR|WK_REPROMPT_DIR|WK_BIN)\}\}(?:\/([A-Za-z0-9_./-]+))?"/g;
export function renderMarkdown(s, file = 'a file') {
  const out = s.replace(MD_CMD, (all, kind, dir, rel) => {
    const p = dir === 'WK_BIN' ? 'bin/wk-ask-claude.mjs' : `${dir === 'WK_REPROMPT_DIR' ? 'reprompt' : 'bin'}/${rel}`;
    const hit = Object.entries(TOOLS).find(([, [k, r]]) => r === p && k === (kind === 'NODE' ? 'node' : 'python'));
    if (!hit) throw new Error(`${file}: no bin/ tool for ${p}`);
    return hit[0];
  });
  if (PLACEHOLDER.test(out)) throw new Error(`${file}: a placeholder is left: ${out.match(PLACEHOLDER)[0]}`);
  return out;
}

export const WK_RUN = `#!/bin/sh
# Runs a Watchkeeper script with Node.js or Python 3: WK_NODE or WK_PYTHON first, then PATH, then the usual places.
# Usage: wk-run node|python <script> [args...]. Exits 127 with a plain message when the runtime is missing.
kind=$1; shift
pick() { for c in "$@"; do if [ -n "$c" ] && [ -f "$c" ] && [ -x "$c" ]; then printf '%s\\n' "$c"; return 0; fi; done; return 1; }
case $kind in
  node) bin=$(pick "\${WK_NODE:-}" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "\${HOME:-/nonexistent}/.volta/bin/node" /usr/bin/node); need='Node.js 20 or newer (nodejs.org)' ;;
  python) bin=$(pick "\${WK_PYTHON:-}" "$(command -v python3 2>/dev/null)" /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3); need='Python 3.9 or newer (python.org)' ;;
  *) echo "wk-run: use node or python, not '$kind'" >&2; exit 64 ;;
esac
[ -n "$bin" ] || { echo "Watchkeeper needs $need. Install it, then start a new conversation." >&2; exit 127; }
exec "$bin" "$@"
`;
export const toolScript = (kind, rel) => `#!/bin/sh
# Watchkeeper tool: runs runtime/${rel} from this plugin's folder.
self=$0
while [ -L "$self" ]; do l=$(readlink "$self"); case $l in /*) self=$l ;; *) self=$(dirname "$self")/$l ;; esac; done
dir=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -P) || exit 1
exec "$dir/libexec/wk-run" ${kind} "$dir/runtime/${rel}" "$@"
`;

const RULES_NOTE = `
## The tools of this plugin
The commands in Watchkeeper's skills (${Object.keys(TOOLS).map(t => `\`${t}\``).join(', ')}) are tools in this plugin's \`bin/\` folder. If the shell does not find one, run it by its full path: \`${INSTALLED_AT}/bin/<name>\`.
`;

function tracked(src) {
  const r = spawnSync('git', ['-C', src, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files failed in ${src}: ${(r.stderr || '').trim()}`);
  return r.stdout.split('\0').filter(Boolean).sort();
}
const put = (file, data, mode = 0o644) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); fs.chmodSync(file, mode); };

export function bundleManifest(base, extra) {
  const m = { ...base, ...extra, name: PLUGIN, version: base.version };
  for (const k of Object.keys(m)) if (m[k] === null) delete m[k];
  return m;
}

// Builds <out>/watchkeeper (and <out>/watchkeeper-antigravity-<version>.zip with zip: true). out must not hold a watchkeeper folder.
export function buildBundle({ src = root(), out, zip = false } = {}) {
  if (!out) throw new Error('--out is required');
  const files = tracked(src);
  const dest = path.join(path.resolve(out), PLUGIN);
  if (fs.existsSync(dest)) throw new Error(`${dest} exists: build into a folder without it`);
  const read = rel => fs.readFileSync(path.join(src, rel));
  const base = JSON.parse(read(`${SRC_DIR}/plugin.json`).toString('utf8'));
  const extra = JSON.parse(read(`${EXTRA_DIR}/plugin.json`).toString('utf8'));
  const version = base.version;
  let runtime = 0;
  for (const f of files) {
    if (RUNTIME_SKIP.some(r => r.test(f))) continue;
    const full = path.join(src, f), st = fs.lstatSync(full);
    if (st.isSymbolicLink()) throw new Error(`${f} is a symlink: the marketplace refuses links out of a plugin`);
    if (!st.isFile()) continue;
    put(path.join(dest, 'runtime', f), fs.readFileSync(full), st.mode & 0o111 ? 0o755 : 0o644);
    runtime++;
  }
  for (const f of files.filter(f => f.startsWith(SRC_DIR + '/'))) {
    const rel = f.slice(SRC_DIR.length + 1), to = path.join(dest, rel);
    if (rel === 'plugin.json') continue;
    if (rel === 'hooks.json') put(to, JSON.stringify(renderHooks(JSON.parse(read(f).toString('utf8'))), null, 2) + '\n');
    else if (rel === 'mcp_config.json') put(to, JSON.stringify(renderMcp(JSON.parse(read(f).toString('utf8'))), null, 2) + '\n');
    else if (rel.endsWith('.md')) put(to, renderMarkdown(read(f).toString('utf8'), rel) + (rel === 'rules/watchkeeper.md' ? RULES_NOTE : ''));
    else if (rel.endsWith('.json') && PLACEHOLDER.test(read(f).toString('utf8'))) throw new Error(`${rel}: a placeholder the bundle cannot fill`);
    else put(to, read(f));
  }
  put(path.join(dest, 'plugin.json'), JSON.stringify(bundleManifest(base, extra), null, 2) + '\n');
  put(path.join(dest, 'README.md'), read(`${EXTRA_DIR}/README.md`).toString('utf8').split('{{VERSION}}').join(version));
  const licence = ['LICENSE', 'public/LICENSE'].find(f => files.includes(f));   // the public tree has it at the root
  if (!licence) throw new Error('no LICENSE in this checkout');
  put(path.join(dest, 'LICENSE'), read(licence));
  put(path.join(dest, 'libexec', 'wk-run'), WK_RUN, 0o755);
  for (const [name, [kind, rel]] of Object.entries(TOOLS)) {
    if (!files.includes(rel)) throw new Error(`bin/${name}: ${rel} is not in this checkout`);
    put(path.join(dest, 'bin', name), toolScript(kind, rel), 0o755);
  }
  const problems = checkBundle(dest);
  if (problems.length) throw new Error(`the bundle failed its check:\n- ${problems.join('\n- ')}`);
  let zipFile = null;
  if (zip) {
    zipFile = path.join(path.resolve(out), `${PLUGIN}-antigravity-${version}.zip`);
    if (fs.existsSync(zipFile)) throw new Error(`${zipFile} exists`);
    const z = spawnSync('zip', ['-qrX', zipFile, PLUGIN], { cwd: path.resolve(out), encoding: 'utf8' });
    if (z.status !== 0) throw new Error(`zip failed: ${(z.stderr || '').trim()}`);
  }
  return { dest, version, runtime, zip: zipFile };
}

function walk(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) walk(dir, r, out); else out.push({ rel: r, link: e.isSymbolicLink() });
  }
  return out;
}
const hookCommands = h => { const c = []; (function w(v) { if (Array.isArray(v)) v.forEach(w); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) k === 'command' && typeof x === 'string' ? c.push(x) : w(x); })(h); return c; };

// What the marketplace and `agy plugin validate --strict` look for, checked without running agy.
export function checkBundle(dest) {
  const p = [], has = rel => fs.existsSync(path.join(dest, rel));
  const all = walk(dest);
  for (const f of all) if (f.link) p.push(`${f.rel} is a symlink`);
  let m = {};
  try { m = JSON.parse(fs.readFileSync(path.join(dest, 'plugin.json'), 'utf8')); } catch (e) { p.push(`plugin.json: ${e.message}`); }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.name || '')) p.push('plugin.json: name must be kebab-case');
  for (const k of ['displayName', 'description', 'version', 'logo']) if (!m[k]) p.push(`plugin.json: ${k} is missing`);
  if (!Array.isArray(m.suggestedPrompts) || !m.suggestedPrompts.length) p.push('plugin.json: suggestedPrompts is missing');
  if (!m.author || !(m.author.name || typeof m.author === 'string')) p.push('plugin.json: author is missing');
  for (const k of ['homepage', 'repository']) if (m[k] && !/^https:\/\//.test(typeof m[k] === 'string' ? m[k] : m[k].url || '')) p.push(`plugin.json: ${k} must be https://`);
  if (m.logo && !has(m.logo)) p.push(`plugin.json: logo ${m.logo} is not in the bundle`);
  if (!has('README.md')) p.push('README.md is missing');
  for (const f of all.filter(f => !f.rel.startsWith('runtime/'))) {
    const s = fs.readFileSync(path.join(dest, f.rel), 'utf8');
    if (PLACEHOLDER.test(s)) p.push(`${f.rel}: placeholder ${s.match(PLACEHOLDER)[0]}`);
    if (/\/Users\/|\/home\/[a-z]/.test(s)) p.push(`${f.rel}: names a home folder`);
  }
  let hooks = {};
  try { hooks = JSON.parse(fs.readFileSync(path.join(dest, 'hooks.json'), 'utf8')); } catch (e) { p.push(`hooks.json: ${e.message}`); }
  for (const c of hookCommands(hooks)) {
    if (/\$\{?PLUGIN_ROOT\}?/.test(c)) p.push(`hooks.json: ${c} names PLUGIN_ROOT (validate --strict fails it)`);
    const m2 = /^\.\/libexec\/wk-run (node|python) (runtime\/[A-Za-z0-9_./-]+)/.exec(c);
    if (!m2) { p.push(`hooks.json: ${c} is not a relative wk-run command`); continue; }
    if (!has(m2[2])) p.push(`hooks.json: ${m2[2]} is not in the bundle`);
  }
  try {
    const mcp = JSON.parse(fs.readFileSync(path.join(dest, 'mcp_config.json'), 'utf8'));
    for (const [n, s] of Object.entries(mcp.mcpServers || {}))
      for (const a of s.args || []) { const r = /^\$\{PLUGIN_ROOT\}\/(.+)$/.exec(a); if (r && !has(r[1])) p.push(`mcp_config.json: ${n}: ${r[1]} is not in the bundle`); }
  } catch (e) { if (has('mcp_config.json')) p.push(`mcp_config.json: ${e.message}`); }
  // every relative import, require and createRequire target of the runtime's JavaScript resolves inside the bundle
  for (const f of all.filter(f => f.rel.startsWith('runtime/') && /\.(mjs|cjs|js)$/.test(f.rel))) {
    const text = fs.readFileSync(path.join(dest, f.rel), 'utf8');
    for (const line of text.split('\n')) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      for (const m of line.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g)) {
        const t = path.posix.normalize(path.posix.join(path.posix.dirname(f.rel), m[2]));
        if (!t.startsWith('runtime/')) { p.push(`${f.rel}: ${m[2]} leads out of runtime/`); continue; }
        if (![t, `${t}.js`, `${t}.mjs`, `${t}/index.js`].some(has)) p.push(`${f.rel}: ${m[2]} is not in the bundle`);
      }
    }
  }
  for (const [name, [, rel]] of Object.entries(TOOLS)) {
    if (!has(`bin/${name}`)) p.push(`bin/${name} is missing`);
    else if (!(fs.statSync(path.join(dest, 'bin', name)).mode & 0o100)) p.push(`bin/${name} is not executable`);
    if (!has(`runtime/${rel}`)) p.push(`runtime/${rel} is missing`);
  }
  return p;
}
