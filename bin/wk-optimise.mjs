#!/usr/bin/env node
// wk-optimise [--apply] [--file settings.json]: the P2-176 token baseline. Dry run prints the diff; --apply backs up first.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const args = process.argv.slice(2), apply = args.includes('--apply'), f = args.includes('--file') ? args[args.indexOf('--file') + 1] : path.join(os.homedir(), '.claude/settings.json');
const want = { autoCompactWindow: 200000, model: 'sonnet', env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '65', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '3', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' },
  modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' }, 'claude-fable-5-1': { effortLevel: 'high' }, 'claude-sonnet-5-5': { effortLevel: 'medium' } } };
const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}, next = structuredClone(cur), diff = [];
const set = (o, k, v, label) => { if (JSON.stringify(o[k]) !== JSON.stringify(v)) { diff.push(`${label}: ${JSON.stringify(o[k])} -> ${JSON.stringify(v)}`); o[k] = v; } };
set(next, 'autoCompactWindow', want.autoCompactWindow, 'autoCompactWindow'); set(next, 'model', want.model, 'model');
next.env ||= {}; for (const [k, v] of Object.entries(want.env)) set(next.env, k, v, `env.${k}`);
next.modelSettings ||= {}; for (const [k, v] of Object.entries(want.modelSettings)) set(next.modelSettings, k, { ...(next.modelSettings[k] || {}), ...v }, `modelSettings.${k}`);
const unused = Object.entries(cur.enabledPlugins || {}).filter(([, on]) => on).map(([k]) => k);
console.log(diff.length ? diff.join('\n') : 'settings already at the baseline');
if (unused.length) console.log(`\nPlugins on (each one is re-read on every call; turn off what the work does not call): ${unused.join(', ')}`);
if (apply && diff.length) { const bak = `${f}.wk-backup-${Date.now()}`; fs.copyFileSync(f, bak); fs.writeFileSync(f, JSON.stringify(next, null, 2) + '\n'); console.log(`\napplied; backup: ${bak}`); }
else if (diff.length) console.log('\n(dry run; add --apply)');
