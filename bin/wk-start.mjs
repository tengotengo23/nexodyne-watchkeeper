#!/usr/bin/env node
// SessionStart: a short, capped orientation (default 6 KB). Prints nothing in projects without a worklog.
import fs from 'node:fs'; import path from 'node:path'; import { proj, root, stdin, pinState, laneOn } from './lib.mjs'; stdin();
const cap = +(process.env.WK_START_BYTES || 6144), p = proj(), out = [];
const rd = f => { try { return fs.readFileSync(path.join(p, f), 'utf8'); } catch { return null; } };
const cut = (s, n) => s.split('\n').map(l => l.slice(0, n)).join('\n');
const st = rd('worklog/STATE.md'); if (st) { const m = st.split(/^## /m).find(b => b.startsWith('Now')); if (m) out.push('== STATE: Now ==\n' + cut(m.split('\n').slice(1, 9).join('\n'), 260)); }
const nt = rd('NOTES_FOR_MASTER.md'); if (nt) out.push('== NOTES ==\n' + cut(nt.split(/^## Done/m)[0].split('\n').slice(0, 14).join('\n'), 240));
const ph = rd('worklog/PHASE.md'); if (ph) out.push('== PHASE head ==\n' + cut(ph.split('\n').slice(0, 5).join('\n'), 200));
const rm = rd('worklog/REMARKS.md'); if (rm) out.push('== REMARKS last 5 ==\n' + cut(rm.split('\n').filter(l => l.startsWith('- 20')).slice(-5).join('\n'), 160));
// one line on the policy pin, kept inside the cap; printed only where the hook prints anything (worklog projects) or in the lane
let pl = ''; try { const ps = pinState(), pin = 'node ' + path.join(root(), 'bin/wk-pin.mjs'); pl = ps.state === 'none' ? 'watchkeeper: policy not pinned; the user pins it with ' + pin : ps.state === 'mismatch' ? 'watchkeeper: policy changed since it was pinned; only read-only tools run until the user reads it and pins again with ' + pin : ''; } catch {}
if (pl && (out.length || laneOn())) { const body = out.join('\n').slice(0, Math.max(0, cap - pl.length - 1)); process.stdout.write((body ? body + '\n' : '') + pl + '\n'); }
else if (out.length) process.stdout.write(out.join('\n').slice(0, cap) + '\n');
