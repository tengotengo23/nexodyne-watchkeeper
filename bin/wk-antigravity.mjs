#!/usr/bin/env node
// wk-antigravity (P2-223): the Watchkeeper plugin for Antigravity (skills, agents, rules, hooks).
//   wk-antigravity install [--dest <plugins dir>] [--pass allow|ask|detect] [--dry-run]
//       -> copies antigravity/plugins/watchkeeper into ~/.gemini/config/plugins/watchkeeper with absolute paths filled in; an
//          older copy goes to ~/.wk/backups/ first. Also writes the hook's pass decision to ~/.wk/antigravity-hook.json: from
//          three keys of ~/.gemini/config/config.json (allow only for Turbo, eager commands and Turbo browser scripts), or --pass (kept until --pass detect)
//   wk-antigravity status [--dest <plugins dir>] [--json]       -> what is installed, the version and the pass decision
//   wk-antigravity bundle --out <dir> [--zip] [--json]           -> the self-contained marketplace copy (P2-275): <dir>/watchkeeper
//          with its own runtime/, relative hooks and bin/ tools, checked; --zip adds watchkeeper-antigravity-<version>.zip.
//          Build it from the public tree only (it copies every tracked file outside test/, docs/, public/, panel/).
// `wk-ask-claude install-antigravity` does the same install. Plain file copies: nothing here runs agy or uses the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installAntigravity, antigravityStatus, passWords } from './antigravity-lib.mjs';
import { buildBundle } from './antigravity-bundle.mjs';

const HOME = os.homedir();
const tilde = p => (p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);

export function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { cmd: 'help' };
  const o = { cmd: argv[0] || '', dest: null, out: null, zip: false, dryRun: false, json: false, pass: undefined };
  const a = argv.slice(1);
  while (a.length) {
    const x = a.shift();
    if (x === '--dest') { o.dest = a.shift(); if (!o.dest) throw new Error('--dest needs a folder'); }
    else if (x === '--dry-run') o.dryRun = true;
    else if (x === '--pass') { o.pass = a.shift(); if (!['allow', 'ask', 'detect'].includes(o.pass)) throw new Error('--pass must be allow, ask or detect'); }
    else if (x === '--json') o.json = true;
    else if (x === '--out') { o.out = a.shift(); if (!o.out) throw new Error('--out needs a folder'); }
    else if (x === '--zip') o.zip = true;
    else throw new Error(`unknown option ${x.slice(0, 40)}`);
  }
  if (o.dest) o.dest = path.resolve(o.dest.replace(/^~(?=\/|$)/, HOME));
  if (o.out) o.out = path.resolve(o.out.replace(/^~(?=\/|$)/, HOME));
  return o;
}

function install(o) {
  const r = installAntigravity({ dest: o.dest || undefined, dryRun: o.dryRun, pass: o.pass });
  if (o.json) { console.log(JSON.stringify(r)); return 0; }
  const words = { current: 'already up to date', installed: 'installed', updated: 'updated', 'would-install': 'would be installed', 'would-update': 'would be updated' };
  console.log(`Antigravity plugin ${words[r.state]}: ${tilde(r.target)} (${r.files.length} files)${r.backup ? `; the old copy is in ${tilde(r.backup)}` : ''}.`);
  if (r.state === 'installed' || r.state === 'updated') console.log('Gemini sees the skills (/wk-take-task, /wk-add-task, /wk-suggest, /ask-claude, /graphify, /re-prompt, /duo-orchestrator, /profession-skill-vault, /wk-status), the agents, the rules, the MCP server and the hooks in its next conversation.');
  if (r.pass) console.log(passWords(r.pass));
  return 0;
}

function status(o) {
  const s = antigravityStatus({ dest: o.dest || undefined });
  if (o.json) { console.log(JSON.stringify(s)); return 0; }
  if (!s.installed) { console.log(`Not installed in ${tilde(s.target)}. Run: node bin/wk-antigravity.mjs install\n${passWords(s.pass)}`); return 0; }
  console.log([
    `Installed: ${tilde(s.target)}, version ${s.version || 'not given'} (this copy of Watchkeeper has ${s.source_version || 'no version'}; ${s.current ? 'up to date' : 'differs: run install to update'}).`,
    `Skills: ${s.skills.join(', ') || 'none'}.`,
    `Agents: ${s.agents.join(', ') || 'none'}.`,
    `Rules: ${s.rules.join(', ') || 'none'}. Hooks: ${s.hooks ? 'on' : 'none'}.`,
    passWords(s.pass),
  ].join('\n'));
  return 0;
}

function bundle(o) {
  if (!o.out) throw new Error('bundle needs --out <folder>');
  const r = buildBundle({ out: o.out, zip: o.zip });
  if (o.json) { console.log(JSON.stringify(r)); return 0; }
  console.log(`Self-contained Antigravity plugin ${r.version}: ${tilde(r.dest)} (${r.runtime} runtime files; checked).${r.zip ? ` Zip: ${tilde(r.zip)}.` : ''}`);
  return 0;
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  try {
    const o = parseArgs(process.argv.slice(2));
    if (o.cmd === 'help') {
      console.log('usage: wk-antigravity install|status|bundle [--dest <plugins dir>] [--pass allow|ask|detect] [--dry-run] [--out <dir>] [--zip] [--json]');
      process.exitCode = 0;
    } else {
      const run = { install, status, bundle }[o.cmd];
      if (!run) { console.error('usage: wk-antigravity install|status|bundle [--dest <plugins dir>] [--pass allow|ask|detect] [--dry-run] [--out <dir>] [--zip] [--json]'); process.exitCode = 2; }
      else process.exitCode = run(o);
    }
  } catch (e) { console.error(`wk-antigravity: ${e.message}`); process.exitCode = 1; }
}
