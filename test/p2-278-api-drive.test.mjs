// P2-278 API drive: wk-keys and wk-ask end to end against fake servers on 127.0.0.1.
// Temp HOME, WK_HOME and WK_KEYS_DIR for every scenario; fake keys only; never the real ~/.wk or ~/.config/watchkeeper.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASK = path.join(ROOT, 'bin', 'wk-ask.mjs');
const KEYS = path.join(ROOT, 'bin', 'wk-keys.mjs');
const GEMINI_FAKE = 'AIza' + 'FAKE' + 'x'.repeat(31) + 'g7Q2';
const CLAUDE_FAKE = 'sk-ant-' + 'FAKE' + '-' + 'y'.repeat(40) + 'c9Z1';
const leaks = s => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t.includes(GEMINI_FAKE) || t.includes(CLAUDE_FAKE) || t.includes('FAKExxxx') || t.includes('FAKE-yyyy'); };

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2278-')));
test.after(() => { fs.rmSync(BASE, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the fake servers (one per provider) and what they saw
const seen = { gemini: [], claude: [] };
const reply = { gemini: null, claude: null };          // a function (req) => { status, headers, body }, or the default
const servers = {};
const host = {};
const DEFAULT = {
  gemini: () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: 'Gemini says hello.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, cachedContentTokenCount: 0 } } }),
  claude: () => ({ status: 200, body: { content: [{ type: 'text', text: 'Claude says hello.' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
};
test.before(async () => {
  for (const p of ['gemini', 'claude']) {
    servers[p] = http.createServer((q, s) => {
      const chunks = [];
      q.on('data', c => chunks.push(c));
      q.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null; try { body = JSON.parse(raw); } catch {}
        const rec = { method: q.method, url: q.url, headers: q.headers, body };
        seen[p].push(rec);
        const r = (reply[p] || DEFAULT[p])(rec, seen[p].length);
        s.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
        s.end(JSON.stringify(r.body));
      });
    });
    await new Promise(r => servers[p].listen(0, '127.0.0.1', r));
    host[p] = `http://127.0.0.1:${servers[p].address().port}`;
  }
});
test.after(() => { for (const s of Object.values(servers)) s.close(); });

// ---------------------------------------------------------------- one sandbox per scenario: home, wk home, keys folder, a git project
let n = 0;
function sandbox() {
  const dir = path.join(BASE, `s${++n}`);
  const home = path.join(dir, 'home'), wk = path.join(home, '.wk'), keys = path.join(dir, 'keys'), proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(wk, { recursive: true });
  const env = { ...process.env, HOME: home, WK_HOME: wk, WK_KEYS_DIR: keys, CLAUDE_PROJECT_DIR: proj,
    WK_GEMINI_API_HOST: host.gemini, WK_ANTHROPIC_API_HOST: host.claude, WK_CALLER: 'terminal', WK_API_RETRY_MS: '10' };
  delete env.CLAUDECODE;
  return { dir, home, wk, keys, proj, env };
}
function run(bin, args, { env, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [bin, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.on('error', reject);
    c.on('close', code => resolve({ code, out, err }));
    c.stdin.end(input ?? '');
  });
}
async function setKey(sb, p, key) {
  const r = await run(KEYS, ['set', p], { env: sb.env, cwd: sb.proj, input: key + '\n' });
  assert.equal(r.code, 0, r.err);
  return r;
}
const usageLines = sb => { const f = path.join(sb.wk, 'api-drive', 'usage.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; };
const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];

// ---------------------------------------------------------------- key store and wk-keys
test('wk-keys: the key comes from stdin only; folder 0700, file 0600, no temp file left; status never shows the key', async () => {
  const sb = sandbox();
  const refused = await run(KEYS, ['set', 'gemini', GEMINI_FAKE], { env: sb.env, cwd: sb.proj });
  assert.equal(refused.code, 2);
  assert.match(refused.err + refused.out, /Refused: a key given as an argument/);
  assert.equal(fs.existsSync(path.join(sb.keys, 'gemini.key')), false, 'an argument key was written');
  assert.ok(!leaks(refused.out + refused.err));

  const g = await setKey(sb, 'gemini', GEMINI_FAKE);
  assert.match(g.out, /Gemini key saved, ends in g7Q2\./);
  await setKey(sb, 'claude', CLAUDE_FAKE);
  assert.equal(fs.statSync(sb.keys).mode & 0o777, 0o700);
  for (const f of ['gemini.key', 'anthropic.key']) assert.equal(fs.statSync(path.join(sb.keys, f)).mode & 0o777, 0o600, f);
  assert.equal(fs.readFileSync(path.join(sb.keys, 'gemini.key'), 'utf8').trim(), GEMINI_FAKE);
  assert.deepEqual(fs.readdirSync(sb.keys).filter(f => f.endsWith('.tmp')), [], 'a temp file was left');

  const st = await run(KEYS, ['status', '--json'], { env: sb.env, cwd: sb.proj });
  assert.equal(st.code, 0, st.err);
  const j = JSON.parse(st.out);
  assert.equal(j.keys.gemini.saved, true); assert.equal(j.keys.gemini.tail, 'g7Q2');
  assert.equal(j.spend.gemini.cap_usd, 2);
  assert.ok(!leaks(st.out + st.err));
  const plain = await run(KEYS, ['status'], { env: sb.env, cwd: sb.proj });
  assert.ok(!leaks(plain.out + plain.err));

  const rm = await run(KEYS, ['remove', 'gemini'], { env: sb.env, cwd: sb.proj });
  assert.equal(rm.code, 0); assert.equal(fs.existsSync(path.join(sb.keys, 'gemini.key')), false);
  for (const f of walk(sb.wk)) assert.ok(!leaks(fs.readFileSync(f, 'utf8')), f);
});

// ---------------------------------------------------------------- wk-ask, both providers
test('wk-ask gemini: x-goog-api-key header, no key in the URL, the model path, a usage line and the cost in the footer', async () => {
  const sb = sandbox(); await setKey(sb, 'gemini', GEMINI_FAKE);
  const before = seen.gemini.length;
  const r = await run(ASK, ['gemini', 'Say hello.'], { env: sb.env, cwd: sb.proj });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'Gemini says hello.\n');
  assert.equal(seen.gemini.length, before + 1);
  const q = seen.gemini.at(-1);
  assert.equal(q.method, 'POST');
  assert.equal(q.url, '/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(q.headers['x-goog-api-key'], GEMINI_FAKE);
  assert.ok(!q.url.includes('key=') && !leaks(q.url), 'the key is in the URL');
  assert.ok(!leaks(q.body), 'the key is in the body');
  assert.equal(q.body.contents[0].parts.at(-1).text, 'Say hello.');
  assert.equal(q.body.generationConfig.maxOutputTokens, 4096);
  const u = usageLines(sb);
  assert.equal(u.length, 1);
  assert.equal(u[0].provider, 'gemini'); assert.equal(u[0].model, 'gemini-3.5-flash-lite'); assert.equal(u[0].caller, 'terminal');
  assert.equal(u[0].in, 1000); assert.equal(u[0].out, 200); assert.equal(u[0].ok, true);
  // 1000 in at US$0.30 per million and 200 out at US$2.50 per million
  assert.ok(Math.abs(u[0].cost - (1000 * 0.30 + 200 * 2.50) / 1e6) < 1e-9, String(u[0].cost));
  assert.match(r.err, /^gemini-3\.5-flash-lite · 1000 in \(0 cached\) · 200 out · about US\$0\.0008 · today US\$0\.0008 of 2\.00\n$/);
  assert.ok(!leaks(r.out + r.err));
});

test('wk-ask claude: x-api-key and anthropic-version, /v1/messages, cache_control on a large file block, --json output', async () => {
  const sb = sandbox(); await setKey(sb, 'claude', CLAUDE_FAKE);
  fs.writeFileSync(path.join(sb.proj, 'big.txt'), 'A line of project text for the cache test.\n'.repeat(120));   // about 5 KB
  fs.writeFileSync(path.join(sb.proj, 'small.txt'), 'tiny\n');
  const r = await run(ASK, ['claude', '--json', '--file', 'big.txt', 'Summarize the file.'], { env: sb.env, cwd: sb.proj });
  assert.equal(r.code, 0, r.err);
  const q = seen.claude.at(-1);
  assert.equal(q.url, '/v1/messages');
  assert.equal(q.headers['x-api-key'], CLAUDE_FAKE);
  assert.equal(q.headers['anthropic-version'], '2023-06-01');
  assert.ok(!leaks(q.url) && !leaks(q.body));
  assert.equal(q.body.model, 'claude-sonnet-5-5');
  const [files, task] = q.body.messages[0].content;
  assert.match(files.text, /=== file: big\.txt ===/);
  assert.deepEqual(files.cache_control, { type: 'ephemeral' });
  assert.equal(task.text, 'Summarize the file.'); assert.equal(task.cache_control, undefined);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true); assert.equal(j.provider, 'claude'); assert.equal(j.answer, 'Claude says hello.');
  assert.equal(j.cap_usd, 2);
  assert.ok(Math.abs(j.cost_usd - (1000 * 2 + 200 * 10) / 1e6) < 1e-9, String(j.cost_usd));
  assert.match(r.err, /claude-sonnet-5-5 · 1000 in \(0 cached\) · 200 out · about US\$0\.0040 · today US\$0\.0040 of 2\.00/);
  const u = usageLines(sb).at(-1);
  assert.equal(u.provider, 'claude'); assert.equal(u.model, 'claude-sonnet-5-5'); assert.equal(u.caller, 'terminal');

  // a small file stays under the cache minimum: no cache_control
  const s = await run(ASK, ['claude', '--file', 'small.txt', 'Read it.'], { env: sb.env, cwd: sb.proj });
  assert.equal(s.code, 0, s.err);
  assert.equal(seen.claude.at(-1).body.messages[0].content[0].cache_control, undefined);
  assert.ok(!leaks(r.out + r.err + s.out + s.err));
});

// ---------------------------------------------------------------- exit codes: nothing is sent
test('exit codes 3, 4, 5 and 6: each refusal makes no request', async () => {
  const total = () => seen.gemini.length + seen.claude.length;
  const cases = [
    ['3: KILL in WK_HOME', 3, sb => fs.writeFileSync(path.join(sb.wk, 'KILL'), '')],
    ['3: KILL at the gates path (~/.wk/KILL under HOME)', 3, sb => { const o = path.join(sb.home, 'other-wk'); fs.mkdirSync(o); sb.env.WK_HOME = o; fs.writeFileSync(path.join(sb.home, '.wk', 'KILL'), ''); }],
    ['4: switched off', 4, sb => fs.writeFileSync(path.join(sb.wk, 'api-drive.json'), '{"enabled":false}')],
    ['5: cap of zero', 5, sb => fs.writeFileSync(path.join(sb.wk, 'api-drive.json'), '{"daily_cap_usd":{"gemini":0}}')],
    ['5: spend at the cap today', 5, sb => { fs.mkdirSync(path.join(sb.wk, 'api-drive'), { recursive: true }); fs.writeFileSync(path.join(sb.wk, 'api-drive', 'usage.jsonl'), JSON.stringify({ time: new Date().toISOString(), provider: 'gemini', model: 'gemini-3.5-flash-lite', caller: 'terminal', in: 1, out: 1, cost: 2, cap_cost: 2, ok: true }) + '\n'); }],
    ['5: hourly limit', 5, sb => { fs.writeFileSync(path.join(sb.wk, 'api-drive.json'), '{"hourly_calls":1}'); fs.mkdirSync(path.join(sb.wk, 'api-drive'), { recursive: true }); fs.writeFileSync(path.join(sb.wk, 'api-drive', 'usage.jsonl'), JSON.stringify({ time: new Date().toISOString(), provider: 'gemini', model: 'gemini-3.5-flash-lite', caller: 'terminal', in: 1, out: 1, cost: 0, cap_cost: 0, ok: true }) + '\n'); }],
    ['5: the worst case passes the cap', 5, sb => fs.writeFileSync(path.join(sb.wk, 'api-drive.json'), '{"daily_cap_usd":{"gemini":0.0001}}')],
    ['6: no key', 6, () => {}, true],
  ];
  for (const [name, code, prep, noKey] of cases) {
    const sb = sandbox();
    if (!noKey) await setKey(sb, 'gemini', GEMINI_FAKE);
    prep(sb);
    const before = total();
    const r = await run(ASK, ['gemini', '--json', 'Say hello.'], { env: sb.env, cwd: sb.proj });
    assert.equal(r.code, code, `${name}: ${r.err}`);
    const j = JSON.parse(r.out);
    assert.equal(j.ok, false, name); assert.equal(j.exit, code, name); assert.equal(j.provider, 'gemini');
    assert.equal(total(), before, `${name}: a request was made`);
    assert.ok(!leaks(r.out + r.err), name);
  }
});

// ---------------------------------------------------------------- file rules
test('file rules: outside the project, a link that leads outside, the keys folder and the size cap are refused with exit 2, nothing sent', async () => {
  const sb = sandbox(); await setKey(sb, 'gemini', GEMINI_FAKE);
  fs.writeFileSync(path.join(sb.dir, 'outside.txt'), 'secret outside\n');
  fs.symlinkSync(path.join(sb.dir, 'outside.txt'), path.join(sb.proj, 'link.txt'));
  fs.writeFileSync(path.join(sb.proj, 'two-kb.txt'), 'x'.repeat(2048));
  const before = seen.gemini.length;
  const tries = [
    [['--file', path.join(sb.dir, 'outside.txt')], /only files inside the project/],
    [['--file', '../outside.txt'], /only files inside the project/],
    [['--file', 'link.txt'], /links that lead outside are refused/],
    [['--file', path.join(sb.keys, 'gemini.key')], /the API key folder is never sent/],
  ];
  // the keys folder inside the project is refused too
  const inKeys = sandbox(); inKeys.env.WK_KEYS_DIR = inKeys.keys = path.join(inKeys.proj, 'keys'); await setKey(inKeys, 'gemini', GEMINI_FAKE);
  for (const [args, re] of tries) {
    const r = await run(ASK, ['gemini', ...args, 'Read it.'], { env: sb.env, cwd: sb.proj });
    assert.equal(r.code, 2, `${args}: ${r.err}`); assert.match(r.err, re); assert.ok(!leaks(r.out + r.err));
  }
  const k = await run(ASK, ['gemini', '--file', 'keys/gemini.key', 'Read it.'], { env: inKeys.env, cwd: inKeys.proj });
  assert.equal(k.code, 2, k.err); assert.match(k.err, /the API key folder is never sent/); assert.ok(!leaks(k.out + k.err));

  fs.writeFileSync(path.join(sb.wk, 'api-drive.json'), '{"max_files_kb":1}');
  const big = await run(ASK, ['gemini', '--file', 'two-kb.txt', 'Read it.'], { env: sb.env, cwd: sb.proj });
  assert.equal(big.code, 2, big.err); assert.match(big.err, /more than 1 KB/);
  assert.equal(seen.gemini.length, before, 'a refused file call made a request');
});

// ---------------------------------------------------------------- redaction and the retry
test('redaction: an answer that echoes the key comes back as [key]; the usage log carries no key', async () => {
  const sb = sandbox(); await setKey(sb, 'gemini', GEMINI_FAKE);
  reply.gemini = () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: `Your key is ${GEMINI_FAKE}, and another is AIzaSyOTHERotherOTHER123.` }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } } });
  try {
    const r = await run(ASK, ['gemini', 'Echo.'], { env: sb.env, cwd: sb.proj });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'Your key is [key], and another is [key].\n');
    const j = await run(ASK, ['gemini', '--json', 'Echo.'], { env: sb.env, cwd: sb.proj });
    assert.equal(JSON.parse(j.out).answer, 'Your key is [key], and another is [key].');
    assert.ok(!leaks(r.out + r.err + j.out + j.err));
  } finally { reply.gemini = null; }
  for (const f of walk(sb.wk)) assert.ok(!leaks(fs.readFileSync(f, 'utf8')), f);
});

test('a 429 is retried once after WK_API_RETRY_MS, then succeeds; a second 429 is not retried again', async () => {
  const sb = sandbox(); await setKey(sb, 'claude', CLAUDE_FAKE);
  let calls = 0;
  reply.claude = () => (++calls === 1 ? { status: 429, body: { error: { type: 'rate_limit_error', message: 'slow down' } } } : DEFAULT.claude());
  try {
    const before = seen.claude.length;
    const r = await run(ASK, ['claude', 'Hello.'], { env: sb.env, cwd: sb.proj });
    assert.equal(r.code, 0, r.err); assert.equal(r.out, 'Claude says hello.\n');
    assert.equal(seen.claude.length, before + 2);
    calls = 0;
    reply.claude = () => { calls++; return { status: 429, body: { error: { type: 'rate_limit_error', message: 'slow down' } } }; };
    const again = await run(ASK, ['claude', 'Hello.'], { env: sb.env, cwd: sb.proj });
    assert.notEqual(again.code, 0); assert.equal(calls, 2, 'more than one retry');
    assert.ok(!leaks(again.out + again.err));
    assert.equal(usageLines(sb).at(-1).ok, false);
  } finally { reply.claude = null; }
});

// ---------------------------------------------------------------- static checks
test('the API drive never starts a process (no child_process), and the phone copy drops the keys card', () => {
  for (const f of ['api-drive-lib.mjs', 'wk-ask.mjs', 'wk-keys.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, 'bin', f), 'utf8');
    assert.doesNotMatch(src, /child_process/, f);
    assert.doesNotMatch(src, /\bagy\b|antigravity agent|['"`]claude['"`]\s*,\s*\[/i, f);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'bin', 'wk-remote.mjs'), 'utf8'), /delete m\.apiKeys/);
});

// ---------------------------------------------------------------- the review's fixes (M1, M5, M4, S3, S4, S6)
test('M1: a test host is refused with the default keys folder (unset, a link to it, a case variant): exit 2 and no request', async () => {
  const sb = sandbox();
  delete sb.env.WK_KEYS_DIR;
  await setKey(sb, 'gemini', GEMINI_FAKE);
  const def = path.join(sb.home, '.config', 'watchkeeper', 'keys');
  assert.ok(fs.existsSync(path.join(def, 'gemini.key')), 'the key went to the default folder under the test HOME');
  fs.symlinkSync(def, path.join(sb.dir, 'keys-link'));
  const before = seen.gemini.length;
  for (const kd of [undefined, def, path.join(sb.dir, 'keys-link'), path.join(sb.home, '.CONFIG', 'Watchkeeper', 'KEYS'), def.replace('/watchkeeper/', '//watchkeeper/')]) {
    const env = { ...sb.env }; if (kd === undefined) delete env.WK_KEYS_DIR; else env.WK_KEYS_DIR = kd;
    const r = await run(ASK, ['gemini', 'Hello.'], { env, cwd: sb.proj });
    assert.equal(r.code, 2, `${kd}: ${r.err}`); assert.match(r.err, /works only with a test keys folder/);
    assert.ok(!leaks(r.out + r.err));
  }
  assert.equal(seen.gemini.length, before, 'a request reached the listener with the default keys folder');
  // a separate test keys folder still works
  const ok = sandbox(); await setKey(ok, 'gemini', GEMINI_FAKE);
  assert.equal((await run(ASK, ['gemini', 'Hello.'], { env: ok.env, cwd: ok.proj })).code, 0);
});

test('M5: a case variant of the keys folder, a project root at $HOME or /, and a key in the outgoing body are refused, nothing sent', async () => {
  const sb = sandbox(); await setKey(sb, 'gemini', GEMINI_FAKE);
  const before = seen.gemini.length;
  const v = await run(ASK, ['gemini', '--file', path.join(sb.dir, 'KEYS', 'gemini.key'), 'Read it.'], { env: sb.env, cwd: sb.proj });
  assert.equal(v.code, 2, v.err); assert.match(v.err, /the API key folder is never sent/); assert.ok(!leaks(v.out + v.err));
  // the keys folder inside the project, named in another case
  const inKeys = sandbox(); inKeys.env.WK_KEYS_DIR = inKeys.keys = path.join(inKeys.proj, 'keys'); await setKey(inKeys, 'gemini', GEMINI_FAKE);
  fs.writeFileSync(path.join(inKeys.proj, 'note.txt'), 'hello\n');
  for (const f of ['KEYS/gemini.key', 'note.txt']) {
    const r = await run(ASK, ['gemini', '--file', f, 'Read it.'], { env: inKeys.env, cwd: inKeys.proj });
    assert.equal(r.code, 2, `${f}: ${r.err}`); assert.match(r.err, /the API key folder is never sent/); assert.ok(!leaks(r.out + r.err));
  }
  // a root at $HOME
  fs.writeFileSync(path.join(sb.home, 'note.txt'), 'hello\n');
  const h = await run(ASK, ['gemini', '--file', 'note.txt', 'Read it.'], { env: { ...sb.env, CLAUDE_PROJECT_DIR: sb.home }, cwd: sb.home });
  assert.equal(h.code, 2, h.err); assert.match(h.err, /is \/ or a home folder/);
  // a root at /
  const s = await run(ASK, ['gemini', '--file', 'etc/hosts', 'Read it.'], { env: { ...sb.env, CLAUDE_PROJECT_DIR: '/' }, cwd: '/' });
  assert.equal(s.code, 2, s.err); assert.match(s.err, /is \/ or a home folder/);
  // the last stop: a key-like text in the task or in a file
  const t = await run(ASK, ['gemini', 'Use AIzaSyOTHERotherOTHER123 please.'], { env: sb.env, cwd: sb.proj });
  assert.equal(t.code, 2, t.err); assert.match(t.err, /looks like an API key, so nothing was sent/);
  fs.writeFileSync(path.join(sb.proj, 'copied.txt'), `key = ${GEMINI_FAKE}\n`);
  const c = await run(ASK, ['gemini', '--file', 'copied.txt', 'Read it.'], { env: sb.env, cwd: sb.proj });
  assert.equal(c.code, 2, c.err); assert.match(c.err, /looks like an API key/); assert.ok(!leaks(c.out + c.err));
  assert.equal(seen.gemini.length, before, 'a refused call made a request');
});

test('M4: 10 parallel runs against an hourly limit of 3 send exactly 3 requests and leave 3 settled log lines', async () => {
  const sb = sandbox(); await setKey(sb, 'gemini', GEMINI_FAKE);
  fs.writeFileSync(path.join(sb.wk, 'api-drive.json'), '{"hourly_calls":3}');
  const before = seen.gemini.length;
  const rs = await Promise.all(Array.from({ length: 10 }, () => run(ASK, ['gemini', 'Hello.'], { env: sb.env, cwd: sb.proj })));
  const codes = rs.map(r => r.code).sort();
  assert.deepEqual(codes, [0, 0, 0, 5, 5, 5, 5, 5, 5, 5], rs.map(r => r.err).join('\n'));
  assert.equal(seen.gemini.length - before, 3, 'requests sent');
  const u = usageLines(sb);
  assert.equal(u.length, 3, JSON.stringify(u));
  for (const l of u) { assert.equal(l.ok, true); assert.equal(l.reserved, undefined); assert.equal(typeof l.cost, 'number'); }
  assert.equal(fs.existsSync(path.join(sb.wk, 'api-drive', '.lock')), false, 'the lock was left behind');
});

test('S3 and N4: tokens are estimated as UTF-8 bytes / 2, for the cap and the Claude cache threshold', async () => {
  process.env.WK_HOME = path.join(BASE, 'unit-wk'); process.env.WK_KEYS_DIR = path.join(BASE, 'unit-keys');
  const { estTokens } = await import(ASK);
  assert.equal(estTokens('abcd'), 2);
  assert.equal(estTokens('ა'.repeat(700)), 1050);
  const sb = sandbox(); await setKey(sb, 'claude', CLAUDE_FAKE);
  fs.writeFileSync(path.join(sb.wk, 'api-drive.json'), '{"claude_cache_min_tokens":1000}');
  fs.writeFileSync(path.join(sb.proj, 'geo.txt'), 'ა'.repeat(700));
  const r = await run(ASK, ['claude', '--file', 'geo.txt', 'Read it.'], { env: sb.env, cwd: sb.proj });
  assert.equal(r.code, 0, r.err);
  assert.ok(JSON.stringify(seen.claude.at(-1).body).includes('cache_control'), 'Georgian text was undercounted');
});

test('S4: an error that carries the key is redacted on stderr and in --json; Retry-After is honoured up to 30 s', async () => {
  const sb = sandbox(); await setKey(sb, 'gemini', GEMINI_FAKE);
  reply.gemini = () => ({ status: 400, body: { error: { message: `API key ${GEMINI_FAKE} is not valid.` } } });
  try {
    const r = await run(ASK, ['gemini', 'Hello.'], { env: sb.env, cwd: sb.proj });
    assert.equal(r.code, 1); assert.match(r.err, /\[key\]/); assert.ok(!leaks(r.out + r.err));
    const j = await run(ASK, ['gemini', '--json', 'Hello.'], { env: sb.env, cwd: sb.proj });
    const o = JSON.parse(j.out); assert.equal(o.ok, false); assert.match(o.error, /\[key\]/); assert.ok(!leaks(j.out + j.err));
  } finally { reply.gemini = null; }
  for (const f of walk(sb.wk)) assert.ok(!leaks(fs.readFileSync(f, 'utf8')), f);

  const { retryWait } = await import(path.join(ROOT, 'bin', 'api-drive-lib.mjs'));
  const res = v => ({ headers: { get: k => (k === 'retry-after' ? v : null) } });
  assert.equal(retryWait(res('3')), 3000);
  assert.equal(retryWait(res('100')), 30000);
  const d = retryWait(res(new Date(Date.now() + 5000).toUTCString())); assert.ok(d > 3000 && d <= 5000, String(d));
  assert.equal(retryWait(res(new Date(Date.now() + 120000).toUTCString())), 30000);
  const old = process.env.WK_API_RETRY_MS;
  try { process.env.WK_API_RETRY_MS = '999999'; assert.equal(retryWait(res(null)), 30000); process.env.WK_API_RETRY_MS = '25'; assert.equal(retryWait(res(null)), 25); }
  finally { if (old === undefined) delete process.env.WK_API_RETRY_MS; else process.env.WK_API_RETRY_MS = old; }

  // end to end: Retry-After 1 wins over WK_API_RETRY_MS=10
  let calls = 0;
  reply.gemini = () => (++calls === 1 ? { status: 503, headers: { 'retry-after': '1' }, body: { error: { message: 'busy' } } } : DEFAULT.gemini());
  try {
    const t0 = Date.now();
    const r = await run(ASK, ['gemini', 'Hello.'], { env: sb.env, cwd: sb.proj });
    assert.equal(r.code, 0, r.err); assert.equal(calls, 2); assert.ok(Date.now() - t0 >= 950, 'Retry-After was not honoured');
  } finally { reply.gemini = null; }
});

test('S6: prices: cached reads and cache writes, Carbon on 30 Nov and 1 Dec, Haiku at 100,000 and 100,001 tokens, an unknown model', async () => {
  const L = await import(path.join(ROOT, 'bin', 'api-drive-lib.mjs'));
  const cfg = { ...JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'api-drive.json'), 'utf8')), claude_cache_write_multiplier: 1.25 };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
  const sonnet = L.priceFor('claude-sonnet-5-5', '2026-11-25', 10000, cfg);
  near(L.costOf('claude', sonnet, { in: 10000, cached: 4000, cache_write: 2000, out: 1000 }, cfg), (4000 * 2 + 2000 * 2 * 1.25 + 4000 * 0.10 + 1000 * 10) / 1e6);
  const flash = L.priceFor('gemini-3.5-flash-lite', '2026-11-25', 10000, cfg);
  near(L.costOf('gemini', flash, { in: 10000, cached: 4000, out: 1000 }, cfg), (6000 * 0.30 + 4000 * 0.03 + 1000 * 2.50) / 1e6);
  assert.equal(L.priceFor('gemini-4-carbon', '2026-11-30', 10, cfg).input, 2.00);
  assert.equal(L.priceFor('gemini-4-carbon', '2026-12-01', 10, cfg).input, 4.00);
  assert.equal(L.priceFor('claude-haiku-5-5', '2026-11-25', 100000, cfg).input, 0.10);
  assert.equal(L.priceFor('claude-haiku-5-5', '2026-11-25', 100001, cfg).input, 0.50);
  const g = L.costForCap('gemini', 'gemini-9-unknown', { in: 1e6, out: 0 }, '2026-11-25', cfg);
  assert.equal(g.cost, null); near(g.cap_cost, 4.00);
  const c = L.costForCap('claude', 'claude-unknown-9', { in: 0, out: 1e6 }, '2026-11-25', cfg);
  assert.equal(c.cost, null); near(c.cap_cost, 20.00);
});
