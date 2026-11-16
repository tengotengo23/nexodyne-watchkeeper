import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto';
export const root = () => process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const proj = () => process.env.CLAUDE_PROJECT_DIR || process.cwd();
export function readJSON(p, d = {}) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } }

// ---- policy (F20): config/gates.json is the one policy file every hook reads. It must parse and hold every key, or the hooks fail closed.
export const policyFile = () => path.join(root(), 'config/gates.json');
// keys a project override (.wk/gates.json) may never touch: loosening any of these waits for the owner
const LOCKED = ['standing_approvals', 'gated', 'kill_switch', 'quarantine', 'lane', 'evidence', '_comment'];
const strs = v => Array.isArray(v) && v.every(x => typeof x === 'string');
function validate(g) {
  const bad = [];
  for (const k of ['denyPathGlobs', 'denyBash', 'secretPatterns', 'claimWords', 'testCommands']) if (!strs(g[k])) bad.push(k);
  if (!strs(g.lane?.denyPathGlobs)) bad.push('lane.denyPathGlobs');
  if (!strs(g.lane?.bashAllow)) bad.push('lane.bashAllow');
  if (!Array.isArray(g.lane?.pii) || !g.lane.pii.length || !g.lane.pii.every(p => typeof p?.id === 'string' && typeof p?.re === 'string')) bad.push('lane.pii');
  if (typeof g.kill_switch?.file !== 'string' || !strs(g.kill_switch?.allowTools)) bad.push('kill_switch');
  if (!strs(g.quarantine?.agentTypes)) bad.push('quarantine.agentTypes');
  if (!Array.isArray(g.standing_approvals)) bad.push('standing_approvals');
  if (!Array.isArray(g.gated)) bad.push('gated');
  const e = g.evidence || {}; if (!(e.maxAgeMinutes > 0) || !(Number.isInteger(e.maxBlocks) && e.maxBlocks >= 1) || typeof e.honestGap !== 'string') bad.push('evidence');
  if (bad.length) throw new Error(`policy ${policyFile()} lacks or mistypes: ${bad.join(', ')}`);
}
let cached = null, cachedPin = null;
// gates() hashes the very bytes it parses and compares them with the pin (see "policy pin" below). On a mismatch, or in lane mode with
// no pin, it throws (every caller fails closed); only the guard passes allowMismatch, because it still lets read-only tools run.
export function gates(opts = {}) {
  if (!cached) {
    let buf; try { buf = fs.readFileSync(policyFile()); } catch (e) { throw new Error(`policy ${policyFile()} unreadable (${String(e.message).slice(0, 80)})`); }
    cachedPin = pinState(buf);
    let g; try { g = JSON.parse(buf.toString('utf8')); } catch (e) { throw new Error(`policy ${policyFile()} unreadable (${String(e.message).slice(0, 80)})`); }
    const of = path.join(proj(), '.wk/gates.json'); let o = {};
    if (fs.existsSync(of)) { try { o = JSON.parse(fs.readFileSync(of, 'utf8')); } catch { throw new Error(`project override ${of} does not parse; the owner fixes it by hand`); } }
    // project overrides may only ADD to deny lists (strings only); other keys need the same type. Loosening needs the owner.
    const DENY = ['denyPathGlobs', 'denyBash', 'secretPatterns'];
    for (const [k, v] of Object.entries(o && typeof o === 'object' ? o : {})) {
      if (LOCKED.includes(k)) continue;
      if (DENY.includes(k)) { if (Array.isArray(v)) g[k] = [...g[k], ...v.filter(x => typeof x === 'string')]; continue; }
      if (Array.isArray(v) && Array.isArray(g[k])) g[k] = [...g[k], ...v.filter(x => typeof x === 'string')];
      else if (typeof v === typeof g[k]) g[k] = v;
    }
    validate(g);
    cached = g;
  }
  if (!opts.allowMismatch) { if (cachedPin.state === 'mismatch') throw new Error(PIN_MSG); if (cachedPin.state === 'none' && laneOn()) throw new Error(LANE_PIN_MSG); }
  return cached;
}
export const policyPin = () => cachedPin;
export function stdin() { try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; } }
export function glob2re(g) {
  const s = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
  return new RegExp('(^|/)' + s.replace(/^\(\?:\.\*\/\)\?/, '') + '$');
}
// <project>/.wk holds the hooks' logs; its own .gitignore ("*") keeps them out of git, written once when missing.
export const wkDir = () => {
  const d = path.join(proj(), '.wk'); fs.mkdirSync(d, { recursive: true });
  try { fs.writeFileSync(path.join(d, '.gitignore'), '*\n', { flag: 'wx' }); } catch { /* already there (kept as the user left it), or not writable */ }
  return d;
};
export const logBlock = (rule, what) => { try { fs.appendFileSync(path.join(wkDir(), 'blocked.log'), `${new Date().toISOString()} ${rule} ${what.slice(0, 200)}\n`); } catch {} };

// ---- kill switch: while the file exists only read-only tools run. A stat error other than "not there" counts as on (fail closed).
export const killFile = g => g.kill_switch.file.replace(/^~(?=\/|$)/, os.homedir());
export function killOn(g) { try { fs.statSync(killFile(g)); return true; } catch (e) { return !['ENOENT', 'ENOTDIR'].includes(e.code); } }

// ---- quarantine: WK_QUARANTINE set to anything but "" or "0", or a subagent whose type is on the quarantine list: no tools at all
export const quarantineEnv = () => { const q = process.env.WK_QUARANTINE; return q !== undefined && q !== '' && q !== '0'; };
export const quarantineAgent = (ev, g) => typeof ev.agent_type === 'string' && g.quarantine.agentTypes.some(t => ev.agent_type === t || ev.agent_type.endsWith(':' + t));

// ---- standing approvals: a gated action runs only when an approval names its gate, is unexpired, and its own (narrower) matchers all match
const reOk = s => { try { return new RegExp(s); } catch { return null; } };
export function activeApproval(a, now = Date.now()) {
  if (!a || typeof a.id !== 'string' || typeof a.description !== 'string' || typeof a.gate !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.expires || '')) return false;
  if (!(now <= Date.parse(a.expires + 'T23:59:59Z'))) return false;   // valid to the end of the expiry day (UTC)
  if (!a.tool && !a.bash) return false;                               // an approval must say what it covers
  return [a.tool, a.bash].filter(x => x !== undefined).every(s => typeof s === 'string' && s && reOk(s));
}
// A gate may carry `bash` (tested on every command position of the normalised command, see normaliseShell) and/or `text`
// (tested on the whole normalised command, for URLs and hosts). A broken regex matches everything (fail closed).
function gateHits(gt, ev) {
  const tool = gt.tool ? reOk(gt.tool) : null, bash = gt.bash ? reOk(gt.bash) : null, text = gt.text ? reOk(gt.text) : null;
  if ((gt.tool && !tool) || (gt.bash && !bash) || (gt.text && !text)) return true;
  if (!tool && !bash && !text) return false;
  if (tool && !tool.test(ev.tool_name || '')) return false;
  if (bash || text) {
    if (ev.tool_name !== 'Bash') return false;
    const n = normaliseShell(ev.tool_input?.command || '');
    return Boolean((bash && n.positions.some(p => bash.test(p))) || (text && text.test(n.text)));
  }
  return true;
}
export function gatedCheck(ev, g) {
  for (const gt of g.gated) {
    if (!gt || typeof gt.id !== 'string' || !gateHits(gt, ev)) continue;
    const ok = g.standing_approvals.find(a => activeApproval(a) && a.gate === gt.id
      && (!a.tool || new RegExp(a.tool).test(ev.tool_name || ''))
      && (!a.bash || (ev.tool_name === 'Bash' && new RegExp(a.bash).test(ev.tool_input?.command || ''))));
    if (!ok) return { gate: gt.id, why: gt.why || 'waits for the owner' };
    try { fs.appendFileSync(path.join(wkDir(), 'approved.log'), `${new Date().toISOString()} ${ok.id} ${gt.id} ${ev.tool_name}\n`); } catch {}
  }
  return null;
}

// ---- lane privacy (F27): the unattended lane reads aggregated snapshots only; its lists and patterns live in gates.json "lane"
export const laneOn = () => process.env.WK_LANE === '1';
export const laneRoots = () => (process.env.WK_LANE_ROOTS || '').split(':').filter(Boolean).map(r => path.resolve(r));
export function scanPII(text) { const hits = []; for (const p of gates().lane.pii) if (new RegExp(p.re, p.flags || '').test(text || '')) hits.push(p.id); return hits; }
const real = p => { let a = path.resolve(p); try { return fs.realpathSync(a); } catch { try { return path.join(fs.realpathSync(path.dirname(a)), path.basename(a)); } catch { return a; } } };
export const realPath = real;
export function inLaneRoots(p) { const a = real(p); return laneRoots().some(r => { const rr = real(r); return a === rr || a.startsWith(rr + path.sep); }); }

// ---- policy pin (finding 1): the owner pins sha256(config/gates.json) with `node bin/wk-pin.mjs`. The pin comes from env
// WK_POLICY_SHA256 (wk-lane sets it at launch; a child process cannot change its parent's environment), else ~/.wk/policy.sha256.
// A pin file that exists but cannot be read counts as a mismatch (fail closed).
export const homeWk = () => path.join(os.homedir(), '.wk');
export const pinFile = () => path.join(homeWk(), 'policy.sha256');
export const READ_ONLY = ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'];   // the kill switch's set, fixed in code: a changed policy cannot widen it
export const PIN_MSG = `policy changed since it was pinned; the user reads it and pins again (node ${path.join(root(), 'bin/wk-pin.mjs')})`;
export const LANE_PIN_MSG = `lane mode needs a pinned policy (env WK_POLICY_SHA256 or ~/.wk/policy.sha256); the user runs node ${path.join(root(), 'bin/wk-pin.mjs')} or starts the lane with bin/wk-lane`;
export const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
export function pinned() {
  const e = process.env.WK_POLICY_SHA256;
  if (e !== undefined && e.trim() !== '') return { pin: e.trim().toLowerCase(), source: 'env WK_POLICY_SHA256' };
  try { return { pin: fs.readFileSync(pinFile(), 'utf8').trim().split(/\s+/)[0].toLowerCase() || '(empty)', source: pinFile() }; }
  catch (err) { return ['ENOENT', 'ENOTDIR'].includes(err.code) ? { pin: null, source: null } : { pin: '(unreadable)', source: pinFile() }; }
}
// state: 'none' (no pin), 'ok', or 'mismatch'. buf: the policy bytes already read (else the file is read here).
export function pinState(buf) {
  const { pin, source } = pinned(); let current = null;
  try { current = sha256(buf ?? fs.readFileSync(policyFile())); } catch {}
  return { pin, source, current, state: !pin ? 'none' : current && pin === current ? 'ok' : 'mismatch' };
}

// ---- shell normaliser (finding 2): gated bash classes are matched on this, never on the raw command.
// Lower-case; heredoc bodies dropped unless a shell or interpreter reads them; quotes and backslashes removed; repeated slashes and
// whitespace collapsed; split into simple commands on ; & | newline ( ) ` { }; every path-like word replaced by its basename (URLs kept).
// A command position is the first word of a simple command, the word after a wrapper (env, command, exec, sudo, doas, nohup, time, nice,
// xargs, builtin, timeout N, stdbuf, which, and the shell keywords if/then/do/else/elif/while/until/!) once the wrapper's options are
// skipped, the word after -c of a shell (sh, bash, zsh, dash, ksh, fish, su), and the word after find's -exec/-execdir/-ok.
// Leading VAR=value words and redirections are skipped; the value, and every option argument skipped after a wrapper, is checked too.
// positions: for each command position, the text from that word to the end of its simple command.
const WRAP = new Set(['env', 'command', 'exec', 'sudo', 'doas', 'nohup', 'time', 'nice', 'xargs', 'builtin', 'timeout', 'stdbuf', 'which', 'if', 'then', 'do', 'else', 'elif', 'while', 'until', '!']);
const ARGOPT = { sudo: ['-u', '-g', '-h', '-p', '-c', '-r', '-t', '-d', '-c'], doas: ['-u', '-c'], nice: ['-n'], env: ['-u', '-s', '-c'], xargs: ['-n', '-i', '-l', '-p', '-s', '-e', '-d', '-a'], timeout: ['-s', '-k'], stdbuf: ['-i', '-o', '-e'] };
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'su']);
const SHELLISH = /\b(sh|bash|zsh|dash|ksh|fish|eval|source|xargs|node|deno|bun|python[\d.]*|ruby|perl|php|lua|osascript|awk|gawk)\b/i;
function dropInertHeredocs(c) {
  const lines = String(c).split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]); const m = lines[i].match(/<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/); if (!m) continue;
    const keep = SHELLISH.test(lines[i]); let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== m[1]; j++) if (keep) out.push(lines[j]);
    if (j < lines.length) out.push(lines[j]); i = j;
  }
  return out.join('\n');
}
const base = t => (t.includes('/') && !/^[a-z][a-z0-9+.-]*:\//.test(t)) ? (t.replace(/\/+$/, '').split('/').pop() || t) : t;
export function normaliseShell(cmd) {
  const s = dropInertHeredocs(cmd).toLowerCase().replace(/['"\\]/g, '').replace(/\/{2,}/g, '/');
  const text = s.replace(/\s+/g, ' ').trim(), positions = [];
  for (const seg of s.split(/[;&|\n()`{}]/)) {
    const w = seg.trim().split(/\s+/).filter(Boolean).map(t => { const m = t.match(/^([a-z_][a-z0-9_]*=)(.*)$/); return m ? m[1] + base(m[2]) : base(t); }); if (!w.length) continue;
    const walk = start => {      // from a command position: skip assignments, redirections and wrappers; returns the command's index
      let j = start, wrapper = null;
      while (j < w.length) {
        const t = w[j];
        if (/^\d*[<>]/.test(t)) { j += /^\d*[<>]+&?$/.test(t) ? 2 : 1; continue; }
        if (/^[a-z_][a-z0-9_]*=/.test(t)) { positions.push(t.slice(t.indexOf('=') + 1)); j++; continue; }
        if (wrapper && t.startsWith('-')) { if ((ARGOPT[wrapper] || []).includes(t) && j + 1 < w.length) { positions.push(w[j + 1]); j += 2; } else j++; continue; }
        if (wrapper === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(t)) { j++; continue; }
        positions.push(w.slice(j).join(' '));
        if (WRAP.has(t)) { wrapper = t; j++; continue; }
        return j;
      }
      return -1;
    };
    const k = walk(0);
    for (let j = Math.max(k, 0) + 1; j < w.length; j++) {
      if ((k >= 0 && SHELLS.has(w[k]) && /^-[a-z]*c[a-z]*$/.test(w[j])) || /^-(exec|execdir|ok|okdir)$/.test(w[j])) walk(j + 1);
    }
  }
  return { text, positions };
}

// ---- policy files in the shell (finding 1): fail closed on ambiguity. Not a boundary: the pin and the OS lock are (see README).
// strong: names gates.json, the plugin's config folder, the pin, the kill file, .wk or wk-pin, or a glob that could match one of them
//   -> only a plain read runs. weak: the word gate/gates/gated, or KILL -> refused when the command also holds a glob, quote,
//   backslash, expansion, redirect, chaining, interpreter or a writing verb, unless it is a plain read.
const READ_VERBS = new Set(['cat', 'head', 'tail', 'grep', 'wc', 'diff', 'ls', 'stat', 'shasum', 'sha256sum']);
const WRITE_VERBS = /(>|\b(tee|sed|perl|cp|mv|rm|ln|truncate|chmod|chown|chflags|xattr|touch|unlink|install|rsync|scp|ditto|dd|jq|awk|gawk|ed|ex|vim?|nvim|nano|emacs|patch|tar|unzip|cpio|sponge|shred|curl|wget|node|deno|bun|python[\d.]*|ruby|php|lua|osascript|swift|eval|source|xargs|find)\b|\bgit\s+(checkout|restore|apply|am|mv|rm|stash|reset|cherry-pick|revert|merge|pull|rebase|switch|clean|update-index|filter-branch|worktree)\b)/i;
const INTERP = /\b(node|deno|bun|python[\d.]*|ruby|perl|php|lua|osascript|awk|gawk|eval|source)\b|\b(ba|z|k|da)?sh\s+(-\w+\s+)*-\w*c\b|<<|(^|[;&|]\s*)\.\s/;
const CONSTRUCT = /[*?[\]'"\\$`<>{}~()\n;&|]/;
export function plainRead(c) {
  c = String(c).trim();
  if (/^node\s+\S*wk-pin\.mjs\s+--check$/.test(c)) return true;
  if (/[\n\r;&|<>$`()]/.test(c)) return false;
  const w = c.split(/\s+/);
  if (READ_VERBS.has(w[0])) return true;
  return w[0] === 'git' && /^(add|log|diff|show|status|blame)$/.test(w[1] || '') && !w.some(t => /^(-c$|--output|--ext-diff|--textconv|-o)/.test(t));
}
const globRe = t => {
  let r = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '*') r += '[^/]*'; else if (ch === '?') r += '[^/]';
    else if (ch === '[' && t.indexOf(']', i + 2) > 0) { const j = t.indexOf(']', i + 2); r += '[' + t.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; }
    else r += ch.replace(/[.+^${}()|\\\]\[]/g, '\\$&');
  }
  try { return new RegExp('^' + r + '$', 'i'); } catch { return /^$/; }
};
// a .wk folder (project or home) as a whole, or its gates, evidence, KILL or policy entries; .wk/blocked.log and the like stay free
const WK_DIR = /(^|[^\w.])\.wk(?!\/(?!gates|evidence|kill|policy)[a-z0-9_-])/i;
export function policyMentions(cmd, g, cwd = proj()) {
  const raw = String(cmd || ''), deq = raw.replace(/['"\\]/g, ''), squash = deq.replace(/[\s+]/g, '');
  const home = os.homedir(), cfg = path.join(root(), 'config');
  const prot = [policyFile(), pinFile(), killFile(g), path.join(proj(), '.wk/gates.json'), path.join(proj(), '.wk/evidence')];
  const absNames = [...new Set([...prot, cfg].flatMap(p => [p, real(p)]))];
  const lc = [raw, deq].map(x => x.toLowerCase());
  let strong = lc.some(x => (/gates\.json|policy\.sha256|wk-pin/.test(x) || WK_DIR.test(x)) || absNames.some(p => x.includes(p.toLowerCase())) || x.includes(path.basename(root()).toLowerCase() + '/config'))
    || /gates\.json/i.test(squash) || WK_DIR.test(squash);
  // the working folder, and every folder the command cd's or pushd's into: inside the plugin, a bare "config" names the policy folder;
  // a cd target that cannot be resolved here ($, backtick, glob) counts as inside
  const rr = real(root()), inside = d => d === rr || d.startsWith(rr + path.sep), base0 = cwd || proj(), dirs = [real(base0)];
  let unknownCd = false;
  for (const m of deq.matchAll(/(?:^|[\s;&|(])(?:cd|pushd)\s+(\S+)/g)) {
    const t = m[1].replace(/^~(?=\/|$)/, home);
    if (/[$`*?[{]/.test(t)) unknownCd = true; else dirs.push(real(path.resolve(base0, t)));
  }
  if (!strong && (unknownCd || dirs.some(inside))) strong = dirs.some(d => d.startsWith(real(cfg))) || /(^|[^\w.-])config(?![\w.-])/i.test(deq);
  if (!strong) {
    const names = ['gates.json', 'config/gates.json', '.wk/gates.json', '.wk/evidence', '.wk/KILL', '.wk/policy.sha256', ...prot.flatMap(p => { const s = p.split('/'); return s.map((_, k) => s.slice(k).join('/')); })];
    for (let t of deq.split(/[\s;&|()<>=`]+/)) {
      t = t.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home).replace(/^(\.\/)+/, '');
      if (!/[*?[]/.test(t) || !/[a-z0-9]/i.test(t.replace(/\.[a-z0-9]+$/i, '').replace(/[*?]|\[[^\]]*\]/g, ''))) continue;
      const re = globRe(t); if (names.some(n => re.test(n))) { strong = true; break; }
    }
  }
  // gateway and gatekeeper words cannot name the policy file (the pin stays the main defence)
  const weak = [raw, deq, squash].some(x => /\bgate[sd]?\b|\bgate(?!way|keeper)/i.test(x)) || /\bKILL\b/.test(deq);
  return { strong, weak };
}
// returns a reason to refuse, or null
export function policyShellCheck(cmd, g, cwd) {
  const c = String(cmd || ''), m = policyMentions(c, g, cwd);
  const interp = INTERP.test(c), cfgWord = interp && /\bconfig\b/i.test(c.replace(/['"\\]/g, '').replace(/[\s+]/g, ' '));
  if (!m.strong && !m.weak && !cfgWord) return null;
  if (plainRead(c)) return null;
  if (m.strong) return 'commands that name the policy (gates.json, its config folder, the pin, the kill file, .wk or wk-pin) may only be plain reads: one cat, head, tail, grep, wc, diff, ls, stat, shasum or sha256sum (or git add/log/diff/show/status/blame) with no redirect, $, backtick or chaining. Change these by hand yourself.';
  if (interp) return 'interpreters, sh -c and heredocs are refused when the command mentions gate or the config folder; change the policy by hand yourself.';
  if (CONSTRUCT.test(c) || WRITE_VERBS.test(c)) return 'a command that mentions gate (or KILL) with a glob, quote, backslash, expansion, redirect, chaining or writing verb is refused unless it is a plain read; change the policy by hand yourself.';
  return null;
}
