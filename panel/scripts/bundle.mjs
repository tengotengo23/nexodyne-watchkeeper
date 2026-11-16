// Builds dist/Watchkeeper-install-<date>.zip for the owner's other computer: the .vsix, watchkeeper-plugin.zip (git archive HEAD,
// so only committed plugin files travel; nothing from ~/.wk) and INSTALL.html. Run scripts/package.mjs first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.join(root, '..'), dist = path.join(repo, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsix = path.join(dist, `${pkg.name}-${pkg.version}.vsix`);
if (!fs.existsSync(vsix)) throw new Error(`missing ${vsix}: run scripts/package.mjs first`);
const d = new Date(), date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-bundle-'));
fs.copyFileSync(vsix, path.join(stage, path.basename(vsix)));
fs.copyFileSync(path.join(root, 'install', 'INSTALL.html'), path.join(stage, 'INSTALL.html'));
execFileSync('git', ['archive', '--format=zip', '-o', path.join(stage, 'watchkeeper-plugin.zip'), 'HEAD'], { cwd: repo });
const listed = execFileSync('unzip', ['-Z1', path.join(stage, 'watchkeeper-plugin.zip')], { encoding: 'utf8' }).split('\n');
const leak = listed.filter(n => /(^|\/)\.wk\//.test(n) || /(^|\/)\.env/.test(n));
if (leak.length) throw new Error(`plugin zip holds data files: ${leak.join(', ')}`);

const out = path.join(dist, `Watchkeeper-install-${date}.zip`);
fs.rmSync(out, { force: true });
execFileSync('zip', ['-q', '-X', out, path.basename(vsix), 'watchkeeper-plugin.zip', 'INSTALL.html'], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`${out} ${fs.statSync(out).size} bytes; plugin zip ${listed.filter(Boolean).length} entries, none from .wk`);
