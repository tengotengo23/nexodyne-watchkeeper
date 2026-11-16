#!/usr/bin/env node
// The owner pins the policy: writes sha256(config/gates.json) to ~/.wk/policy.sha256 and prints it. Run it after each hand edit.
// usage: node bin/wk-pin.mjs           pin the current policy (it must parse and validate first)
//        node bin/wk-pin.mjs --check   exit 0 when the policy matches the pin, 1 otherwise (not pinned, changed, unreadable)
// The guard refuses this script from the model's shell except --check, and refuses tool writes to the pin file.
import fs from 'node:fs'; import path from 'node:path';
import { gates, pinState, pinFile, policyFile } from './lib.mjs';
const ps = pinState();
if (process.argv.includes('--check')) {
  if (ps.state === 'ok') { console.log(`ok: ${policyFile()} matches the pin (${ps.source})`); process.exit(0); }
  console.log(ps.state === 'none' ? `not pinned: run node bin/wk-pin.mjs to pin ${policyFile()}` : `MISMATCH: ${policyFile()} has changed since it was pinned (${ps.source}); the owner checks the change, then re-runs wk-pin`);
  process.exit(1);
}
try { gates({ allowMismatch: true }); } catch (e) { console.error(`wk-pin: not pinned, the policy is invalid: ${e.message}`); process.exit(2); }
if (!ps.current) { console.error(`wk-pin: cannot read ${policyFile()}`); process.exit(2); }
const f = pinFile(), tmp = `${f}.${process.pid}.tmp`;
fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
fs.writeFileSync(tmp, ps.current + '\n', { mode: 0o600 }); fs.renameSync(tmp, f);
console.log(ps.current);
console.error(`wk-pin: pinned ${policyFile()} in ${f}`);
const e = process.env.WK_POLICY_SHA256;
if (e && e.trim() && e.trim().toLowerCase() !== ps.current) console.error('wk-pin: note: WK_POLICY_SHA256 in this environment is a different pin and wins over the file; restart the lane or unset it.');
