// bridge-link (P2-227): the transport under wk-bridge, and nothing else. It spawns the link (ssh, or a test command), frames JSON lines
// both ways (a line over 2 MB is dropped and logged), and reconnects with a backoff from 5 s to 5 min. It knows no message types:
// the protocol (hello, state, result, job, keys out; cmd, key in) lives in wk-bridge.mjs, so another transport can sit here later.
import { spawn } from 'node:child_process';

export const MAX_LINE = 2 * 1024 * 1024;
export const BACKOFF = { base: 5000, max: 300000 };

// The one ssh argv. -F /dev/null and IdentityAgent=none: no other key is ever offered (the server's forced command is the only door).
export function sshArgv({ host, port, user }, keyPath) {
  if (typeof host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/.test(host)) throw new Error('remote.json "host" is not a host name or address');
  if (typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error('remote.json "user" is not a user name');
  if (!(Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Error('remote.json "port" must be 1 to 65535');
  if (typeof keyPath !== 'string' || !keyPath.startsWith('/')) throw new Error('the key path must be absolute');
  return ['-F', '/dev/null', '-T', '-i', keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15',
    '-p', String(port), `${user}@${host}`];
}

export const backoffMs = (attempt, { base = BACKOFF.base, max = BACKOFF.max } = {}) => Math.min(max, base * 2 ** Math.max(0, attempt));

// One connection. onLine gets each parsed object; the promise in .closed resolves with { code, signal, err } when the link ends.
export function openLink({ file, args = [], env = process.env, onLine = () => {}, log = () => {} }) {
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
  let buf = '', dropping = false, errTail = '', open = true;
  const closed = new Promise(resolve => {
    child.on('error', e => { open = false; resolve({ code: null, signal: null, err: e.message }); });
    child.on('close', (code, signal) => { open = false; resolve({ code, signal, err: errTail.trim().split('\n').pop() || '' }); });
  });
  child.stdin.on('error', () => { /* the link ended: .closed says so */ });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    for (;;) {
      const i = buf.indexOf('\n');
      if (i < 0) {
        if (buf.length > MAX_LINE) { if (!dropping) log({ ev: 'line-dropped', bytes: buf.length }); dropping = true; buf = ''; }
        return;
      }
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (dropping) { dropping = false; continue; }   // the end of a line that was too long
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE) { log({ ev: 'line-dropped', bytes: line.length }); continue; }
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { log({ ev: 'line-not-json' }); continue; }
      if (o && typeof o === 'object' && !Array.isArray(o)) onLine(o); else log({ ev: 'line-not-object' });
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { errTail = (errTail + d).slice(-1000); });
  return {
    pid: child.pid,
    closed,
    get open() { return open; },
    send(obj) {
      if (!open) return false;
      const s = JSON.stringify(obj);
      if (Buffer.byteLength(s, 'utf8') > MAX_LINE) { log({ ev: 'send-too-large', t: obj && obj.t, bytes: s.length }); return false; }
      try { child.stdin.write(s + '\n'); return true; } catch { return false; }
    },
    close() { try { child.stdin.end(); } catch { /* gone */ } try { child.kill('SIGTERM'); } catch { /* gone */ } },
  };
}

// Keep a link up: connect() opens one and resolves when it ends. A link that stayed up a minute starts the backoff again.
export async function keepLinked({ connect, stopped, base, max, sleep = ms => new Promise(r => setTimeout(r, ms)), onWait = () => {} }) {
  let attempt = 0;
  while (!stopped()) {
    const t0 = Date.now();
    await connect();
    if (stopped()) break;
    if (Date.now() - t0 > 60000) attempt = 0;
    const ms = backoffMs(attempt++, { base, max });
    onWait(ms);
    await sleep(ms);
  }
}
