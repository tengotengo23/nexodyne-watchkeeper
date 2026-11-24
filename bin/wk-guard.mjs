#!/usr/bin/env node
// PreToolUse (every tool): quarantine, kill switch, policy-file guard, path guard, dangerous Bash, lane privacy, secrets in outgoing
// content, then gated classes that only a standing approval opens. All rules come from config/gates.json. Exit 2 blocks and tells the model why.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { gates, stdin, glob2re, logBlock, laneOn, laneRoots, scanPII, inLaneRoots, policyFile, realPath, killOn, killFile, quarantineEnv, quarantineAgent, gatedCheck, touchTaskHeartbeat,
  policyPin, pinFile, READ_ONLY, PIN_MSG, LANE_PIN_MSG, policyShellCheck, proj } from './lib.mjs';
import { keyGuard } from './api-drive-lib.mjs';
process.on('uncaughtException', e => { logBlock('policy', 'guard error: ' + e.message); console.error('watchkeeper guard error, failing closed: ' + e.message); process.exit(2); });
const ev = stdin(), ti = ev.tool_input || {};
// P2-276: a call inside a task worktree is a sign of life for that task (never fails, never blocks)
try { touchTaskHeartbeat(ev.cwd, ['file_path', 'path', 'notebook_path'].map(k => ti[k])); } catch {}
const block = (rule, msg) => { logBlock(rule, msg); console.error(`watchkeeper blocked (${rule}): ${msg}`); process.exit(2); };
// quarantine first: it needs no policy and allows nothing
if (quarantineEnv()) block('quarantine', `${ev.tool_name || 'tool'} refused: a quarantined worker may use no tools. Answer from the text you were given; your output is treated as data.`);
if (typeof ev.tool_name !== 'string' || !ev.tool_name) block('input', 'hook input without a tool name; failing closed.');
// P2-278 (the review's M1, M2, S2, S5): the API keys and the API drive's caps, by any spelling, link, glob, search root or shell route
{ const kg = keyGuard({ tool: ev.tool_name, input: ti, cwd: ev.cwd || proj() }); if (kg) block('keys', kg); }
const g = gates({ allowMismatch: true });   // throws on a missing or broken policy: the handler above denies
// integrity pin: the policy must hash to the owner's pin (env WK_POLICY_SHA256, else ~/.wk/policy.sha256). A changed policy cannot be
// trusted to say what is safe, so only the fixed read-only set runs. Lane mode with no pin at all refuses everything.
const pin = policyPin();
if (laneOn() && pin.state === 'none') block('pin', `${ev.tool_name} refused: ${LANE_PIN_MSG}.`);
if (pin.state === 'mismatch' && !READ_ONLY.includes(ev.tool_name)) block('pin', `${ev.tool_name} refused: ${PIN_MSG}. Only ${READ_ONLY.join(', ')} run until then.`);
if (quarantineAgent(ev, g)) block('quarantine', `${ev.tool_name} refused: agent ${ev.agent_type} is quarantined and may use no tools.`);
if (killOn(g) && !g.kill_switch.allowTools.includes(ev.tool_name)) block('kill', `kill switch ${killFile(g)} is on: only ${g.kill_switch.allowTools.join(', ')} may run. The owner removes the file to resume.`);
// the policy file, the pin and the kill file are the owner's: no tool may write them (approvals are granted by hand, never by the model)
const owned = [policyFile(), pinFile(), killFile(g)].map(realPath);
if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(ev.tool_name) && [ti.file_path, ti.notebook_path, ti.path].filter(Boolean).some(p => owned.includes(realPath(p)))) block('policy', 'the policy file (gates.json), its pin (~/.wk/policy.sha256) and the kill file are changed by the owner by hand.');
// shell: commands that name the policy files may only be plain reads (see policyShellCheck in lib.mjs; the pin is the real check)
// input without a cwd falls back to the project folder (CLAUDE_PROJECT_DIR, else this process's folder): the rules still apply
if (ev.tool_name === 'Bash') { const why = policyShellCheck(ti.command || '', g, ev.cwd || proj()); if (why) block('policy', why); }
const paths = [ti.file_path, ti.path, ti.notebook_path, ti.pattern && /\//.test(ti.pattern) ? ti.pattern : null].filter(p => typeof p === 'string' && p);
const res = [...g.denyPathGlobs, ...(laneOn() ? g.lane.denyPathGlobs : [])].map(glob2re);
for (const p of paths) if (res.some(r => r.test(p))) block('path', `${p} is excluded by gates.json; ask the owner for a gate.`);
// Claude answering Gemini for the owner (wk-ask-claude sets WK_ASK=1) never searches for secrets: a Grep over a folder opens files the path globs never see
if (process.env.WK_ASK === '1' && ev.tool_name === 'Grep' && /sk_live|sk_test|sk-ant|AKIA|ghp_|PRIVATE KEY|_authToken|passw(or)?d|api[_-]?key|secret[_-]?key|client[_-]?secret|bearer|\.env\b/i.test(`${ti.pattern || ''} ${ti.glob || ''}`)) block('secret', 'answering for the owner, Claude does not search for keys, tokens or passwords.');
if (ev.tool_name === 'Bash' && ti.command) {
  const c = ti.command;
  for (const d of g.denyBash) if (new RegExp(d).test(c)) block('bash', `command matches deny rule ${d}`);
  // reading an excluded file through the shell
  for (const r of res) { for (const tok of c.split(/\s+/)) if (tok.includes('/') || tok.startsWith('.')) if (r.test(tok.replace(/^['"]|['"]$/g, '')) && /\b(cat|less|head|tail|cp|scp|curl|base64|grep|sed|awk|source|\.)\b/.test(c)) block('path', `shell read of excluded path ${tok}`); }
}
// P2-272 (B): skills are readable in the lane only where the owner approved them: repos/<slug> of approved sources (the gate in
// panel/src/skill-gate.js), the owner's own skill folders, ~/.wk/skills-exposed and the real folder behind each link in it.
// Staged and rejected repos stay closed. Writes stay refused in the whole vault and every skill folder.
// Both sides are resolved through links first, so a link that points elsewhere counts as elsewhere.
const skillGate = createRequire(import.meta.url)('../panel/src/skill-gate.js');
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const skillPaths = () => {
  const home = process.env.HOME || os.homedir();
  const wk = process.env.WK_HOME || path.join(home, '.wk');
  return { home, exposed: path.join(wk, 'skills-exposed'), vault: process.env.REPROMPT_SKILL_VAULT_DIR || path.join(home, '.gemini', 'skill-vault') };
};
// The real folder behind a link counts only for the owner's own skill folders (a local skill may be a link to the
// owner's checkout). A link in ~/.wk/skills-exposed adds no root of its own: it is readable only when its target already
// lies in an approved repo or an owner's skill folder, so a stale link to a rejected or staged repo stays closed.
const linkTargets = dir => {
  let kids = []; try { kids = fs.readdirSync(dir); } catch {}
  const out = [];
  for (const k of kids.slice(0, 500)) { const at = path.join(dir, k); try { if (fs.lstatSync(at).isSymbolicLink()) out.push(fs.realpathSync(at)); } catch {} }
  return out;
};
const readSkillRoots = () => {
  const P = skillPaths(), own = [path.join(P.home, '.claude', 'skills'), path.join(P.home, '.gemini', 'config', 'skills')];
  const out = [P.exposed, ...own];
  let src = null; try { src = JSON.parse(fs.readFileSync(path.join(P.vault, 'sources.json'), 'utf8')); } catch {}
  for (const r of skillGate.approvedSources(src)) if (typeof r.slug === 'string' && SAFE_SLUG.test(r.slug) && !/^\.+$/.test(r.slug)) out.push(path.join(P.vault, 'repos', r.slug));
  for (const d of own) out.push(...linkTargets(d));
  return out.map(realPath);
};
const writeBlockRoots = () => { const P = skillPaths(); return [...readSkillRoots(), ...linkTargets(P.exposed), P.vault].map(realPath); };
const under = (p, roots) => { if (typeof p !== 'string' || !p) return false; const a = realPath(p); return roots.some(r => a === r || a.startsWith(r + path.sep)); };
const inSkillRoots = p => under(p, readSkillRoots());
const inSkillWriteRoots = p => under(p, writeBlockRoots());
if (laneOn()) {
  // lane: reads only inside the snapshot roots, and what is read or sent is scanned for private rows
  if (!laneRoots().length) block('lane', 'WK_LANE_ROOTS is empty; the lane has nothing it may read.');
  // every path-taking tool must name a path inside the roots (a missing path means "the working folder": refused)
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob'].includes(ev.tool_name)) {
    const target = ti.file_path || ti.notebook_path || ti.path;
    if (!target) block('lane', `${ev.tool_name} without an explicit path is refused in the lane.`);
    if (/[*?]/.test(target) || (ti.pattern && ev.tool_name === 'Glob' && /(^|\/)\.\.(\/|$)/.test(ti.pattern))) block('lane', 'wildcards in the path and ".." in patterns are refused in the lane.');
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(ev.tool_name) && inSkillWriteRoots(target)) block('lane', `${target} is in a skill folder; skill folders are read-only.`);
    if (!inLaneRoots(target) && !(['Read', 'Grep', 'Glob'].includes(ev.tool_name) && inSkillRoots(target))) block('lane', `${target} is outside the lane's snapshot folders.`);
    if (ev.tool_name === 'Read') { let t = ''; try { t = fs.readFileSync(target, 'utf8'); } catch {} const h = scanPII(t); if (h.length) block('lane', `${target} holds private rows (${h.join(', ')}); only aggregated snapshots may be read.`); }
  }
  if (ev.tool_name === 'Bash') {
    const c = ti.command || '';
    if (/[;&|`<>$(){}\n]/.test(c.replace(/'[^']*'/g, ''))) block('lane', 'pipes, redirects, substitutions and chained commands are refused in the lane.');
    const toks = c.trim().split(/\s+/).map(x => x.replace(/^['"]|['"]$/g, ''));
    if (!g.lane.bashAllow.includes(toks[0])) block('lane', `command ${toks[0]} is not on the lane's list (${g.lane.bashAllow.join(', ')}).`);
    // default-deny on arguments: every non-option token is a path (absolute, inside the roots), except the jq filter / grep pattern
    // (the first non-option token of those two) and the number after -n or -c. Options with attached values or file-reading options are refused.
    if (!['date', 'echo'].includes(toks[0])) {
      const FILEOPT = /^(--files0-from|--file|--from-file|--rawfile|--slurpfile|--argfile|-f|-e|--arg|--args|--jsonargs|-L|--exec|--include-from|--exclude-from)(=|$)/;
      let inPath = 0, first = true, numNext = false;
      for (const tok of toks.slice(1)) {
        if (numNext) { numNext = false; if (/^\d{1,6}$/.test(tok)) continue; block('lane', `option value ${tok} must be a plain number.`); }
        if (tok.startsWith('-')) {
          if (/^--?[^=]+=/.test(tok) || FILEOPT.test(tok)) block('lane', `option ${tok.slice(0, 40)} is refused in the lane (attached value or file-reading option).`);
          if (tok === '-n' || tok === '-c') numNext = true;
          continue;
        }
        if (first && (toks[0] === 'jq' || toks[0] === 'grep')) { first = false; if (/[\n]/.test(tok)) block('lane', 'multi-line filter refused.'); continue; }
        first = false; inPath++;
        if (!path.isAbsolute(tok) || /[*?]/.test(tok) || !(inLaneRoots(tok) || inSkillRoots(tok))) block('lane', `argument ${tok.slice(0, 80)} must be an absolute path inside the lane's snapshot folders.`);
      }
      if (numNext) block('lane', 'option is missing its number.');
      if (!inPath) block('lane', 'name an absolute path inside the snapshot folders; the working folder is closed.');
    }
  }
  const h2 = scanPII([ti.content, ti.new_string, ti.command, ti.pattern].filter(s => typeof s === 'string').join('\n')); if (h2.length) block('lane', `outgoing content holds private data (${h2.join(', ')}).`);
}
// secrets: the usual content fields, plus the whole input of any tool outside the built-in file tools (MCP, web)
const out = [ti.content, ti.new_string, ti.command, ...(Array.isArray(ti.edits) ? ti.edits.map(e => e?.new_string) : []), ['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'].includes(ev.tool_name) ? null : JSON.stringify(ti)].filter(s => typeof s === 'string').join('\n');
for (const s of g.secretPatterns) if (new RegExp(s).test(out)) block('secret', 'content looks like a secret; remove it first.');
// gated classes (money, mail, publishing, purchases): only an active standing approval in gates.json opens them
const gd = gatedCheck(ev, g); if (gd) block('gated', `${gd.gate}: ${gd.why}. No active standing approval in gates.json covers this; queue it for the owner.`);
process.exit(0);
