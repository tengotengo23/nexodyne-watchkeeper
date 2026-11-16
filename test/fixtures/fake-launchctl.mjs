#!/usr/bin/env node
// A stand-in for launchctl (P2-227 bridge tests only): appends its argv to FAKE_LAUNCHCTL_LOG, exits FAKE_LAUNCHCTL_EXIT (default 0).
import fs from 'node:fs';
if (process.env.FAKE_LAUNCHCTL_LOG) fs.appendFileSync(process.env.FAKE_LAUNCHCTL_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
if (process.env.FAKE_LAUNCHCTL_EXIT && process.env.FAKE_LAUNCHCTL_EXIT !== '0') { process.stderr.write('fake launchctl: refused\n'); process.exit(Number(process.env.FAKE_LAUNCHCTL_EXIT)); }
