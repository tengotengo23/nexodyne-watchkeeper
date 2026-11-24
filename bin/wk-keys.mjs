#!/usr/bin/env node
// wk-keys (P2-278): the API drive's key store from a terminal. The key is never printed; status shows saved or not and the last four characters.
//   wk-keys status [--json]            per provider: saved or not, ends in, last check result and time
//   wk-keys set <gemini|claude>        reads the key from stdin only (pipe it in, or paste and press Ctrl-D); a key given as an argument is refused
//   wk-keys remove <gemini|claude>     deletes the saved key (no backup of a secret)
//   wk-keys check <gemini|claude>      a free model-list call with the saved key; the result goes to the status file
// Exit: 0 fine · 1 check failed · 2 bad use. Env: WK_KEYS_DIR (test override of ~/.config/watchkeeper/keys), WK_GEMINI_API_HOST, WK_ANTHROPIC_API_HOST.
// No child processes here.
import * as L from './api-drive-lib.mjs';

const say = s => process.stdout.write(s + '\n');
const fail = (s, code = 2) => { process.stderr.write(L.redact(s) + '\n'); process.exit(code); };
const USAGE = 'Use: wk-keys status | set <gemini|claude> (key on stdin) | remove <gemini|claude> | check <gemini|claude>';

async function readStdin() {
  if (process.stdin.isTTY) process.stderr.write('Paste the key, then press Enter and Ctrl-D. It is not shown.\n');
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [cmd, prov, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') { say(USAGE); return; }
  if (cmd === 'status') {
    const st = L.status(), sp = L.spendSummary();
    if (prov === '--json') { say(JSON.stringify({ keys: st, spend: sp }, null, 2)); return; }
    for (const p of Object.keys(L.PROVIDERS)) say(`${L.PROVIDERS[p].label}: ${L.statusLine(st[p])} · today US$${sp[p].today_usd.toFixed(2)} of ${sp[p].cap_usd.toFixed(2)}`);
    if (!sp.enabled) say('The API drive is switched off in ~/.wk/api-drive.json.');
    return;
  }
  if (!['set', 'remove', 'check'].includes(cmd)) fail(USAGE);
  const p = L.normProvider(prov);
  if (!p) fail('Name the provider: gemini or claude.');
  if (cmd === 'set') {
    // never the key as an argument: it would end up in shell history and the process list
    if (rest.length) fail('Refused: a key given as an argument could end up in shell history and the process list. Pipe it in (wk-keys set ' + p + ' < file) or use the W panel.');
    const key = await readStdin();
    const bad = L.keyProblem(key); if (bad) fail(bad);
    const r = L.saveKey(p, key);
    say(`${L.PROVIDERS[p].label} key saved, ends in ${r.tail}.`);
    return;
  }
  if (rest.length) fail(USAGE);
  if (cmd === 'remove') { const r = L.removeKey(p); say(r.removed ? `${L.PROVIDERS[p].label} key removed.` : `No ${L.PROVIDERS[p].label} key was saved.`); return; }
  const r = await L.checkKey(p);
  if (!r.saved) fail(`${L.PROVIDERS[p].label}: ${L.NO_KEY_MSG}`, 1);
  say(`${L.PROVIDERS[p].label}: ${L.statusLine({ saved: true, tail: r.tail, checked: r.checked, ok: r.ok, text: r.text })}`);
  if (!r.ok) process.exit(1);
}
main().catch(e => fail(`wk-keys: ${e.message}`, 2));
