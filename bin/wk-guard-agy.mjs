#!/usr/bin/env node
// Antigravity PreToolUse hook (P2-223): turns Antigravity's hook input into wk-guard's input, so Gemini meets the same
// rules as Claude (kill switch, excluded paths, hard resets and force pushes, secrets, gated classes).
// In:  stdin {toolCall: {name, args}, conversationId, cwd, workspacePaths, ...}   (camelCase; antigravity.google/docs/hooks)
// hooks.json matches every tool (matcher ""), so the hook sees every call in Antigravity, the owner's own chats too.
// Watchkeeper's rules apply only to the conversations that do Watchkeeper work: from the first call that runs a
// Watchkeeper script (wk-task, wk-suggest, wk-state, wk-ask-claude), names the data folder, or has a cwd, workspace or
// path in it, until the conversation ends. That call marks the conversation in <data>/gemini/guarded.jsonl and meets the
// rules itself. Without a conversationId, each call is judged alone. Your own chats are not changed: no rule, no kill
// switch, no log, only the pass decision below.
// Out: {"decision":"deny","reason":"..."} when wk-guard blocks. Otherwise the pass decision:
//   allow: Antigravity runs the call without asking you. ask: Antigravity asks you first; an unattended run (the hourly
//   automation) then refuses the call.
//   This machine's decision is in ~/.wk/antigravity-hook.json (written by wk-antigravity install; "allow" only under the
//   Turbo preset, eager commands and Turbo browser scripts). Your own chats get it for every tool (no file, as in the
//   self-contained marketplace plugin: the same three settings are read at each call, so allow only under Turbo).
//   In Watchkeeper's conversations the 8 tools below get it (no file: config/gemini.json hook_pass_decision, else "ask"),
//   and every other tool gets "ask": Watchkeeper cannot know what your own Antigravity rules say for it.
// Antigravity ignores a hook that exits non-zero, so this always exits 0 and fails closed by printing deny.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gates, glob2re, touchTaskHeartbeat } from './lib.mjs';
import { detectPass } from './antigravity-lib.mjs';

const HERE_FILE = fileURLToPath(import.meta.url);
const BIN = path.dirname(HERE_FILE);
const say = o => { process.stdout.write(JSON.stringify(o) + '\n'); };
const deny = reason => say({ decision: 'deny', reason: String(reason).trim().slice(0, 1000) || 'Watchkeeper refused this call.' });
const GIT_PUSH = /\bgit\b[^;&|\n]*\spush\b/;
const pick = (o, keys) => { for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k]; return undefined; };
export const KNOWN = ['run_command', 'view_file', 'read_file', 'write_to_file', 'write_file', 'replace_file_content', 'edit_file', 'multi_replace_file_content', 'list_dir', 'grep_search', 'find_by_name'];
// path arguments of Antigravity's tools (hooks docs and agy-facts), plus the usual spellings
const PATH_KEYS = ['AbsolutePath', 'TargetFile', 'FilePath', 'DirectoryPath', 'SearchPath', 'SearchDirectory', 'Directory', 'File', 'Path', 'Uri', 'Source', 'Destination', 'SourcePath', 'DestinationPath', 'file_path', 'path', 'notebook_path', 'uri'];
const pathsIn = args => {
  const out = PATH_KEYS.map(k => args[k]).filter(v => typeof v === 'string' && v);
  for (const [k, v] of Object.entries(args)) if (typeof v === 'string' && v && /(path|file|dir(ectory)?)$/i.test(k) && !out.includes(v)) out.push(v);
  return out;
};
const WRITE_TOOL = /write|replace|edit|create|delete|remove|move|rename|save|patch|mkdir|copy/i;

// Antigravity tool -> the Claude tool wk-guard knows. Argument names from the hooks docs; other known spellings as a fallback.
export function callOf(ev) {
  const call = ev && typeof ev.toolCall === 'object' && ev.toolCall ? ev.toolCall : {};
  const name = typeof call.name === 'string' ? call.name : '';
  let args = call.args;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* kept as text */ } }
  if (typeof args === 'string') args = { CommandLine: args };   // a bare string is checked as a command
  if (!args || typeof args !== 'object') args = {};
  return { name, args };
}
export function toGuard(ev) {
  const { name, args } = callOf(ev);
  const cwd = pick(args, ['Cwd', 'cwd']) || (typeof ev.cwd === 'string' && ev.cwd) || (Array.isArray(ev.workspacePaths) && typeof ev.workspacePaths[0] === 'string' ? ev.workspacePaths[0] : undefined);
  const file = pick(args, ['AbsolutePath', 'TargetFile', 'FilePath', 'file_path', 'path', 'Path']);
  const t = (tool_name, tool_input) => ({ tool_name, tool_input, cwd });
  switch (name) {
    case 'run_command': {
      const cmd = pick(args, ['CommandLine', 'commandLine', 'Command', 'command', 'cmd']);
      return t('Bash', { command: cmd !== undefined ? cmd : JSON.stringify(args) });   // unknown shape: the whole args are checked
    }
    case 'view_file':
    case 'read_file': return t('Read', { file_path: file || '' });
    case 'write_to_file':
    case 'write_file': return t('Write', { file_path: file || '', content: pick(args, ['CodeContent', 'Content', 'content']) || '' });
    case 'replace_file_content':
    case 'edit_file': return t('Edit', { file_path: file || '', new_string: pick(args, ['ReplacementContent', 'Replacement', 'new_string']) || '' });
    case 'multi_replace_file_content': {
      const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [];
      return t('MultiEdit', { file_path: file || '', edits: chunks.map(c => ({ new_string: c && typeof c === 'object' ? String(c.ReplacementContent ?? '') : String(c) })) });
    }
    case 'list_dir': return t('LS', { path: pick(args, ['DirectoryPath', 'SearchPath', 'path']) || '' });
    case 'grep_search': return t('Grep', { pattern: pick(args, ['Query', 'pattern']) || '', path: pick(args, ['SearchPath', 'SearchDirectory', 'DirectoryPath', 'path']) || '' });
    case 'find_by_name': return t('Glob', { pattern: pick(args, ['Pattern', 'pattern']) || '', path: pick(args, ['SearchDirectory', 'SearchPath', 'DirectoryPath', 'path']) || '' });
    default: {   // any other tool: the kill switch and the secret scan of its whole input apply; its paths meet the deny globs
      const ps = pathsIn(args);
      return t(name, ps.length ? { ...args, file_path: ps[0], path: ps[1] || ps[0] } : args);
    }
  }
}

const wkHome = () => path.resolve(process.env.WK_HOME || path.join(os.homedir(), '.wk'));
export function machinePass() {
  try { const d = JSON.parse(fs.readFileSync(path.join(wkHome(), 'antigravity-hook.json'), 'utf8')).pass; if (['allow', 'ask'].includes(d)) return d; } catch {}
  return null;
}
export function passDecision(name) {
  if (!KNOWN.includes(name)) return 'ask';
  const m = machinePass(); if (m) return m;
  try { const d = JSON.parse(fs.readFileSync(path.join(BIN, '..', 'config', 'gemini.json'), 'utf8')).hook_pass_decision; if (['allow', 'ask', 'force_ask'].includes(d)) return d; } catch {}
  return 'ask';
}

// The data folder (~/.wk or $WK_HOME) holds the tasks, the suggestions and the kill switch: no file tool writes there, except
// in worktrees/, where Gemini works. Symlinks are resolved first, so a link cannot lead around this.
const realish = p => {
  let cur = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); }
    catch { const up = path.dirname(cur); if (up === cur) return path.resolve(p); rest.push(path.basename(cur)); cur = up; }
  }
};
const under = (p, dir) => p === dir || p.startsWith(dir + path.sep);
export function dataWrite(name, args, cwd) {
  if (!(['write_to_file', 'write_file', 'replace_file_content', 'edit_file', 'multi_replace_file_content'].includes(name) || (!KNOWN.includes(name) && WRITE_TOOL.test(name)))) return null;
  const home = realish(wkHome()), trees = path.join(home, 'worktrees');
  const treesOk = realish(trees) === trees;   // worktrees/ itself a link: no exception at all
  for (const raw of pathsIn(args)) {
    const p = realish(path.resolve(cwd || os.homedir(), raw.replace(/^~(?=\/|$)/, os.homedir())));
    if (under(p, home) && !(treesOk && p !== trees && under(p, trees))) return p;
  }
  return null;
}

// P2-272 (B): the skill vault (~/.gemini/skill-vault) is read-only to Gemini's file tools as well; the exposed skills
// (~/.wk/skills-exposed) already sit inside the data folder above. Reads there go on to wk-guard, which allows them in
// the lane after resolving links.
const skillVault = () => path.resolve(process.env.REPROMPT_SKILL_VAULT_DIR || path.join(os.homedir(), '.gemini', 'skill-vault'));
export function skillWrite(name, args, cwd) {
  if (!(['write_to_file', 'write_file', 'replace_file_content', 'edit_file', 'multi_replace_file_content'].includes(name) || (!KNOWN.includes(name) && WRITE_TOOL.test(name)))) return null;
  const vault = realish(skillVault());
  for (const raw of pathsIn(args)) {
    const p = realish(path.resolve(cwd || os.homedir(), raw.replace(/^~(?=\/|$)/, os.homedir())));
    if (under(p, vault)) return p;
  }
  return null;
}

// ---------------------------------------------------------------- which conversations do Watchkeeper work
const WK_SCRIPT = /(^|[^A-Za-z0-9_-])wk-(task|suggest|state|ask-claude)(\.mjs)?(?![A-Za-z0-9_-])/;
const guardedFile = () => path.join(wkHome(), 'gemini', 'guarded.jsonl');
const convOf = ev => (ev && typeof ev.conversationId === 'string' && ev.conversationId && ev.conversationId.length <= 200 ? ev.conversationId : null);
export function isWkWork(ev, call, cwd) {
  const home = wkHome(), real = realish(home);
  const inData = raw => {
    if (typeof raw !== 'string' || !raw) return false;
    const p = realish(path.resolve(cwd || os.homedir(), raw.replace(/^~(?=\/|$)/, os.homedir())));
    return under(p, real) || under(path.resolve(cwd || os.homedir(), raw.replace(/^~(?=\/|$)/, os.homedir())), home);
  };
  const places = [cwd, typeof ev.cwd === 'string' ? ev.cwd : null, ...(Array.isArray(ev.workspacePaths) ? ev.workspacePaths : [])];
  if (places.some(inData)) return true;
  if (pathsIn(call.args).some(inData)) return true;
  if (call.name === 'run_command') {
    const text = JSON.stringify(call.args);
    if (WK_SCRIPT.test(text) || text.includes(BIN)) return true;
    const names = [home, real, '~/.wk', '$HOME/.wk', '${HOME}/.wk', '$WK_HOME', '${WK_HOME}'];
    if (home.startsWith(os.homedir() + path.sep)) names.push('~' + home.slice(os.homedir().length));
    if (names.some(n => text.includes(n))) return true;
  }
  return false;
}
export function isMarked(conv) {
  try { return fs.readFileSync(guardedFile(), 'utf8').split('\n').some(l => { try { return JSON.parse(l).conversation_id === conv; } catch { return false; } }); } catch { return false; }
}
export function mark(conv, now = new Date()) {
  const f = guardedFile(); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(f), 0o700);
  let lines = []; try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch {}
  lines.push(JSON.stringify({ at: now.toISOString(), conversation_id: conv }));
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.slice(-500).join('\n') + '\n', { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, f);
}

export function main(raw) {
  let ev;
  try { ev = JSON.parse(raw || '{}'); } catch { return deny('Watchkeeper could not read the hook input, so it refused the call.'); }
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return deny('Watchkeeper could not read the hook input, so it refused the call.');
  const g = toGuard(ev);
  // P2-276: a call inside a task worktree is a sign of life for that task (never fails, never blocks)
  try { touchTaskHeartbeat(g.cwd, pathsIn(callOf(ev).args)); } catch {}
  {
    const call = callOf(ev), conv = convOf(ev), work = isWkWork(ev, call, g.cwd);
    let guarded = work;
    if (conv) {
      guarded = isMarked(conv);
      if (!guarded && work) {
        try { mark(conv); } catch { return deny('Watchkeeper could not record this conversation as Watchkeeper work, so it refused the call.'); }
        guarded = true;
      }
    }
    if (!guarded) return say({ decision: machinePass() || detectPass().pass });   // your own chat: no Watchkeeper rule at all
  }
  if (!g.tool_name) return deny('Watchkeeper got a tool call without a name, so it refused it.');
  const call = callOf(ev);
  const hit = dataWrite(call.name, call.args, g.cwd);
  if (hit) return deny(`watchkeeper blocked (gemini): ${hit} is in Watchkeeper's data folder. Only Watchkeeper's own commands write there; work in your worktree.`);
  const sk = skillWrite(call.name, call.args, g.cwd);
  if (sk) return deny(`watchkeeper blocked (gemini): ${sk} is in the skill vault; skill folders are read-only.`);
  // wk-guard checks two paths (file_path, path); a tool with more path arguments has the rest checked here
  const extra = KNOWN.includes(call.name) ? [] : pathsIn(call.args).slice(2);
  if (extra.length) {
    let res; try { res = gates({ allowMismatch: true }).denyPathGlobs.map(glob2re); } catch { return deny('Watchkeeper could not load its policy, so it refused the call.'); }
    const bad = extra.find(p => res.some(r => r.test(p)));
    if (bad) return deny(`watchkeeper blocked (path): ${bad} is excluded by gates.json; ask the owner for a gate.`);
  }
  // blocked.log goes to the workspace's .wk/ (as with Claude), else ~/.wk/
  const proj = (Array.isArray(ev.workspacePaths) && typeof ev.workspacePaths[0] === 'string' && path.isAbsolute(ev.workspacePaths[0]))
    ? ev.workspacePaths[0]
    : (typeof g.cwd === 'string' && path.isAbsolute(g.cwd) ? g.cwd : os.homedir());
  const r = spawnSync(process.execPath, [path.join(BIN, 'wk-guard.mjs')], { input: JSON.stringify(g), encoding: 'utf8', timeout: 8000,   // well inside the hook's 30 s, so a slow guard is a deny, never a skipped hook
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, CLAUDE_PLUGIN_ROOT: path.resolve(BIN, '..') } });
  if (r.status === 0) {
    // Gemini's own lane is stricter than Claude's: it works in a worktree and never pushes, so any git push stops here.
    if (g.tool_name === 'Bash' && GIT_PUSH.test(String(g.tool_input.command))) return deny('watchkeeper blocked (gemini): Gemini never pushes. Finish with wk-task done; the owner merges, and pushing stays with the owner.');
    return say({ decision: passDecision(call.name) });
  }
  const why = String(r.stderr || '').trim().split('\n').filter(Boolean).pop() || (r.error ? `the guard did not run (${r.error.message})` : 'the guard refused it');
  return deny(why);
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(HERE_FILE);
if (isMain) {
  try { main(fs.readFileSync(0, 'utf8')); } catch (e) { deny(`Watchkeeper's hook failed (${e.message}), so it refused the call.`); }
  process.exitCode = 0;
}
