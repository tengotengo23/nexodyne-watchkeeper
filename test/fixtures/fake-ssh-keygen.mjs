#!/usr/bin/env node
// A stand-in for ssh-keygen (P2-227 bridge tests only). -f <file> makes a fake key pair; -F <host> exits 0 when FAKE_KNOWN=1.
// Each call appends its argv to FAKE_KEYGEN_LOG.
import fs from 'node:fs';
const a = process.argv.slice(2);
if (process.env.FAKE_KEYGEN_LOG) fs.appendFileSync(process.env.FAKE_KEYGEN_LOG, JSON.stringify(a) + '\n');
if (a[0] === '-F') process.exit(process.env.FAKE_KNOWN === '1' ? 0 : 1);
const f = a[a.indexOf('-f') + 1];
if (!f || process.env.FAKE_KEYGEN_FAIL === '1') { process.stderr.write('fake keygen: failed\n'); process.exit(1); }
fs.writeFileSync(f, 'FAKE PRIVATE KEY (test only)\n', { mode: 0o644 });
fs.writeFileSync(f + '.pub', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKEfake wk-remote\n');
