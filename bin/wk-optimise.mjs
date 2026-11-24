#!/usr/bin/env node
// wk-optimise [--apply] [--file settings.json]: the P2-176 token baseline, changed in P2-250: the default model comes from env.ANTHROPIC_MODEL, and the tool no longer writes the model key; since P2-267 (owner, 20 Nov 2026) that default is Opus 5.5 at xhigh effort. Dry run prints the diff; --apply backs up first.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: wk-optimise [--apply] [--file settings.json]');
  process.exit(0);
}
const fileIdx = args.indexOf('--file');
if (fileIdx >= 0 && (!args[fileIdx + 1] || args[fileIdx + 1].startsWith('--'))) {
  console.error('wk-optimise: --file needs a path');
  process.exit(2);
}
const apply = args.includes('--apply'), f = fileIdx >= 0 ? args[fileIdx + 1] : path.join(os.homedir(), '.claude/settings.json');
const want = { autoCompactWindow: 200000, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '65', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet', ANTHROPIC_MODEL: 'opus' },
  modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' }, 'claude-fable-5-1': { effortLevel: 'high' }, 'claude-fable-5-2': { effortLevel: 'high' }, 'claude-sonnet-5-5': { effortLevel: 'medium' } } };
let cur = {};
if (fs.existsSync(f)) {
  try {
    cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
      console.error(`wk-optimise: ${f} must contain a JSON object`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`wk-optimise: could not parse ${f}: ${e.message}`);
    process.exit(1);
  }
}
const next = structuredClone(cur), diff = [];
const set = (o, k, v, label) => { if (JSON.stringify(o[k]) !== JSON.stringify(v)) { diff.push(`${label}: ${JSON.stringify(o[k])} -> ${JSON.stringify(v)}`); o[k] = v; } };
set(next, 'autoCompactWindow', want.autoCompactWindow, 'autoCompactWindow');
next.env ||= {}; for (const [k, v] of Object.entries(want.env)) set(next.env, k, v, `env.${k}`);
next.modelSettings ||= {}; for (const [k, v] of Object.entries(want.modelSettings)) set(next.modelSettings, k, { ...(next.modelSettings[k] || {}), ...v }, `modelSettings.${k}`);
const unused = Object.entries(cur.enabledPlugins || {}).filter(([, on]) => on).map(([k]) => k);
console.log(diff.length ? diff.join('\n') : 'settings already at the baseline');
if (diff.some(d => d.startsWith('env.ANTHROPIC_MODEL'))) console.log('New sessions start on Opus 5.5 at xhigh effort. /model picks another model for one session. To undo, remove env.ANTHROPIC_MODEL.');
if (unused.length) console.log(`\nPlugins on (each one is re-read on every call; turn off what the work does not call): ${unused.join(', ')}`);
if (apply && diff.length) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let bak = null;
  if (fs.existsSync(f)) {
    bak = `${f}.wk-backup-${Date.now()}`;
    fs.copyFileSync(f, bak);
  }
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
  console.log(`\napplied${bak ? `; backup: ${bak}` : ''}`);
}
else if (diff.length) console.log('\n(dry run; add --apply)');
