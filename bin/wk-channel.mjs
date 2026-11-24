#!/usr/bin/env node
// wk-channel (P2-272): copies the developer's signed channel files to the folder the https channel is served from.
//   wk-channel publish --to <folder> [--dry-run]   copies release/channel/update.json and news.json, each with its .sig,
//                                                  only when the signature verifies with the developer's key; any other
//                                                  file is refused by name (exit 1). Never deletes anything; makes the
//                                                  folder if it is missing. Nothing goes to a server: copy the folder up
//                                                  yourself (or point --to at a mounted web folder).
//   wk-channel check                               reads the https channel as a user's computer does and says what it found
// The key: the one pinned on this computer (~/.wk/release-key.pub.pem), or else release/release-key.pub, which is
// labelled NOT PINNED: a key from the repository proves nothing about who signed.
// Env (tests): WK_HOME, WK_UPDATE_REPO (default: this folder), WK_CHANNEL_URL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES, KEY_IN_REPO, CHANNEL_IN_REPO, DEFAULT_URL, pinnedKeyPath, wkHome, verifyChannelFile, checkFile, fingerprint, readChannel } from './channel-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repoDir = () => path.resolve(process.env.WK_UPDATE_REPO || path.join(HERE, '..'));

export const NOT_PINNED = 'NOT PINNED: from the repository, so this proves nothing about who signed';
function findKey(repo, home) {
  for (const [p, source] of [[pinnedKeyPath(home), 'pinned'], [path.join(repo, KEY_IN_REPO), NOT_PINNED]]) {
    try { const pem = fs.readFileSync(p, 'utf8'); fingerprint(pem); return { pem, source }; } catch { /* next */ }
  }
  return null;
}
export function releaseKey(repo, home = wkHome()) { const k = findKey(repo, home); return k ? k.pem : null; }
// 'pinned', the NOT PINNED label, or null when there is no key.
export function releaseKeySource(repo, home = wkHome()) { const k = findKey(repo, home); return k ? k.source : null; }

// What publish would copy and what it refuses. { copy: [names], refused: [{ file, why }] }.
export function plan(src, pem) {
  const copy = [], refused = [];
  let names = []; try { names = fs.readdirSync(src); } catch { return { copy, refused: [{ file: src, why: 'there is no channel folder yet' }] }; }
  for (const n of names.sort()) {
    if (n.endsWith('.sig') && FILES.includes(n.slice(0, -4))) continue;   // travels with its file
    if (!FILES.includes(n)) { refused.push({ file: n, why: 'not a channel file' }); continue; }
    let bytes, sig;
    try { bytes = fs.readFileSync(path.join(src, n)); sig = fs.readFileSync(path.join(src, `${n}.sig`), 'utf8').trim(); } catch { refused.push({ file: n, why: 'it has no .sig' }); continue; }
    if (!pem || !verifyChannelFile(bytes, sig, pem)) { refused.push({ file: n, why: 'its signature does not verify with the developer\'s key' }); continue; }
    const r = checkFile(n, { bytes, sig }, pem);
    if (r.problem) { refused.push({ file: n, why: r.problem }); continue; }
    copy.push(n);
  }
  for (const n of names) if (n.endsWith('.sig') && FILES.includes(n.slice(0, -4)) && !names.includes(n.slice(0, -4))) refused.push({ file: n, why: 'a signature without its file' });
  return { copy, refused };
}

export function publish({ repo = repoDir(), to, dryRun = false, home = wkHome() }) {
  if (!to) throw new Error('say where: --to <folder>');
  const src = path.join(repo, CHANNEL_IN_REPO), dest = path.resolve(to);
  if (dest === path.resolve(src)) throw new Error('--to is the channel folder itself');
  const pem = releaseKey(repo, home);
  const p = plan(src, pem);
  if (!pem) p.refused.unshift({ file: KEY_IN_REPO, why: 'no developer key here, so nothing can be checked' });
  if (!dryRun && p.copy.length) {
    fs.mkdirSync(dest, { recursive: true });
    for (const n of p.copy) for (const f of [n, `${n}.sig`]) {
      const t = path.join(dest, `.${f}.${process.pid}.tmp`);
      fs.copyFileSync(path.join(src, f), t); fs.renameSync(t, path.join(dest, f));
    }
  }
  return { ...p, dest, dryRun };
}

const USAGE = `usage: wk-channel publish --to <folder> [--dry-run] | check
publish copies only the channel files whose signatures verify; check reads ${DEFAULT_URL} as users do.`;
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const a = process.argv.slice(2), cmd = a[0];
  if (!cmd || a.includes('--help') || a.includes('-h')) { console.log(USAGE); process.exit(cmd ? 0 : 2); }
  try {
    if (cmd === 'publish') {
      const r = publish({ to: a.includes('--to') ? a[a.indexOf('--to') + 1] : undefined, dryRun: a.includes('--dry-run') });
      const src = releaseKeySource(repoDir());
      if (src) console.log(`key ${fingerprint(releaseKey(repoDir()))} (${src})`);
      for (const n of r.copy) console.log(`${r.dryRun ? 'would copy' : 'copied'}: ${n} + ${n}.sig -> ${r.dest}`);
      for (const x of r.refused) console.log(`refused: ${x.file}: ${x.why}`);
      if (!r.copy.length && !r.refused.length) console.log('nothing to publish yet');
      process.exit(r.refused.length ? 1 : 0);
    } else if (cmd === 'check') {
      const r = await readChannel({ url: process.env.WK_CHANNEL_URL || DEFAULT_URL, repo: repoDir() });
      console.log(`key ${r.key || 'none pinned'}; contact ${r.contact || 'none yet (it comes with the signed news)'}`);
      for (const f of FILES) { const x = r[f]; console.log(`${f}: ${x.value ? `verified (${x.from})` : x.missing ? 'not published yet' : x.problem}`); }
      process.exit(FILES.some(f => r[f].problem) ? 1 : 0);
    } else { console.error(USAGE); process.exit(2); }
  } catch (e) { console.error(`wk-channel: ${e.message}`); process.exit(1); }
}
