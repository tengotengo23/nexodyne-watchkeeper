#!/usr/bin/env node
// Copies the one Re-Prompt app page (reprompt/ui/reprompt_app.html) byte for byte to its two copies.
// Usage: node bin/wk-sync-app-page.mjs [--check]   (--check only reports drift, exit 1 when a copy differs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = path.join(root, 'reprompt', 'ui', 'reprompt_app.html');
export const COPIES = [
  path.join(root, 'panel', 'media', 'reprompt_app.html'),
  path.join(root, 'reprompt', 'ide-extension', 'media', 'reprompt_app.html'),
];

export function drift() {
  const src = fs.readFileSync(SOURCE);
  return COPIES.filter(c => !fs.existsSync(c) || !fs.readFileSync(c).equals(src));
}

export function sync() {
  const src = fs.readFileSync(SOURCE);
  const changed = [];
  for (const c of COPIES) {
    if (fs.existsSync(c) && fs.readFileSync(c).equals(src)) continue;
    fs.mkdirSync(path.dirname(c), { recursive: true });
    fs.writeFileSync(c, src);
    changed.push(c);
  }
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const d = drift();
    if (d.length) { console.error('Out of sync:\n' + d.map(x => '  ' + path.relative(root, x)).join('\n')); process.exit(1); }
    console.log('App page copies match the source.');
  } else {
    const c = sync();
    console.log(c.length ? 'Updated:\n' + c.map(x => '  ' + path.relative(root, x)).join('\n') : 'App page copies already match the source.');
  }
}
