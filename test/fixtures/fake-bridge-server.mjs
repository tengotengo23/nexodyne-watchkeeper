#!/usr/bin/env node
// A stand-in for the server end of the W link (P2-227), for the bridge tests only: used as WK_SSH_BIN (it then sees ssh's exact argv)
// or as --transport-cmd. All in FAKE_SERVER_DIR: argv.jsonl (one line per connection), from-mac.jsonl (every line the Mac sent),
// to-mac.jsonl (lines the test wants sent; the offset survives reconnects in to-mac.offset), quit (when it appears: removed, exit 0).
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_SERVER_DIR;
if (!dir) { process.stderr.write('FAKE_SERVER_DIR is not set\n'); process.exit(9); }
fs.appendFileSync(path.join(dir, 'argv.jsonl'), JSON.stringify(process.argv.slice(2)) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) { fs.appendFileSync(path.join(dir, 'from-mac.jsonl'), buf.slice(0, i) + '\n'); buf = buf.slice(i + 1); }
});
process.stdin.on('end', () => process.exit(0));
const offFile = path.join(dir, 'to-mac.offset');
setInterval(() => {
  if (fs.existsSync(path.join(dir, 'quit'))) { fs.rmSync(path.join(dir, 'quit')); process.stderr.write('fake server: bye\n'); process.exit(0); }
  let text; try { text = fs.readFileSync(path.join(dir, 'to-mac.jsonl'), 'utf8'); } catch { return; }
  const off = Number(fs.existsSync(offFile) ? fs.readFileSync(offFile, 'utf8') : 0) || 0;
  const end = text.lastIndexOf('\n') + 1;
  if (end > off) { process.stdout.write(text.slice(off, end)); fs.writeFileSync(offFile, String(end)); }
}, 30);
