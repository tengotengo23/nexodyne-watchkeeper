// P2-227: wk-remote, the Mac end of the phone link. A temp HOME and WK_HOME; ssh, ssh-keygen, launchctl and claude are fakes in test/fixtures.
// Nothing here reaches the server, the real ~/.wk, ~/.ssh, ~/.claude or ~/Library.
import nodeTest from "node:test"; import assert from 'node:assert/strict';
// P2-282: these tests run sh stubs (launchctl, systemctl, sh -c); on Windows each one is skipped with the reason.
const UNIX_ONLY = process.platform === "win32" && "needs sh stub scripts (launchctl, systemctl, sh -c), which Windows does not run";
const test = UNIX_ONLY ? (name, o, f) => nodeTest(name, { ...(typeof o === "object" && o ? o : {}), skip: UNIX_ONLY }, typeof o === "function" ? o : f) : nodeTest;
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-remote-')));
const WK = path.join(HOME, '.wk');
process.env.HOME = HOME; process.env.WK_HOME = WK;
fs.mkdirSync(WK, { recursive: true });
const BIN = path.resolve('bin/wk-remote.mjs'), FX = path.resolve('test/fixtures');
const SERVER = path.join(FX, 'fake-bridge-server.mjs');
// the version wk-remote reports is read from the plugin manifest, so a release bump never breaks this test
const WK_VERSION = JSON.parse(fs.readFileSync(path.resolve('.claude-plugin/plugin.json'), 'utf8')).version;
const B = await import('../bin/wk-remote.mjs');
const { sshArgv } = await import('../bin/bridge-link.mjs');
const L = await import('../bin/remote-lib.mjs');
const P = await import('./fixtures/passkey.mjs');
const D = (await import('node:module')).createRequire(import.meta.url)('../panel/src/data.js');

// orchestration with two open questions (one about money) and a fake nx; a project for jobs
const ORCH = path.join(HOME, 'Projects', 'nexo', 'orchestration');
fs.mkdirSync(ORCH, { recursive: true }); fs.mkdirSync(path.join(HOME, 'Projects', 'nexo', '.git'));
fs.writeFileSync(path.join(ORCH, 'QUESTIONS.md'), '# Questions\n\n- [ ] Q7 (2026-11-14 09:00, tab ?): T-1 Show the pace bar first? Recommended: yes.\n- [ ] Q8 (2026-11-14 10:00, tab ?): T-2 Buy the domain? Recommended: buy it.\n');
fs.writeFileSync(path.join(ORCH, 'nx'), "#!/usr/bin/env node\nconst fs=require('fs'),p=require('path'),a=process.argv.slice(2);fs.appendFileSync(p.join(__dirname,'argv.jsonl'),JSON.stringify(a)+'\\n');\nconst q=p.join(__dirname,'QUESTIONS.md');fs.writeFileSync(q,fs.readFileSync(q,'utf8').replace('- [ ] Q'+a[1]+' ','- [x] Q'+a[1]+' '));console.log('RECORDED');\n", { mode: 0o755 });
fs.writeFileSync(path.join(WK, 'projects.json'), JSON.stringify({ projects: [{ key: 'nexo', name: 'nexo', path: '~/Projects/nexo', kind: 'repo' }] }));
const nxCalls = () => { try { return fs.readFileSync(path.join(ORCH, 'argv.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };
// a neutral server (192.0.2.10 is a documentation address); the passkey fixture's origin stays localhost
const SERVER_HOST = '192.0.2.10';
const remoteBase = { enabled: true, origin: P.ORIGIN, rp_id: P.RP, host: SERVER_HOST, user: 'root', orchestration: ORCH, task_repo: path.join(HOME, 'Projects', 'nexo') };
const setRemote = o => fs.writeFileSync(path.join(WK, 'remote.json'), JSON.stringify({ ...remoteBase, ...o }));
const pk = P.makePasskey('Test phone');

const SRV = path.join(HOME, 'srv'); fs.mkdirSync(SRV);
const LCTL = path.join(HOME, 'launchctl.jsonl'), KGLOG = path.join(HOME, 'keygen.jsonl');
const env = { ...process.env, HOME, WK_HOME: WK, FAKE_SERVER_DIR: SRV, WK_SSH_BIN: SERVER, WK_SSH_KEYGEN: path.join(FX, 'fake-ssh-keygen.mjs'), FAKE_KEYGEN_LOG: KGLOG,
  WK_LAUNCHCTL: path.join(FX, 'fake-launchctl.mjs'), FAKE_LAUNCHCTL_LOG: LCTL, WK_CLAUDE_BIN: path.join(FX, 'fake-claude-job.mjs'), FAKE_JOB_LOG: path.join(WK, 'fake-claude.jsonl'),
  WK_JOB_FREE_MB: '8000', WK_JOB_PACE_PCT: 'none', WK_JOB_KILL_MS: '500', WK_BRIDGE_TICK_MS: '100', WK_BRIDGE_MIN_PUSH_MS: '300', WK_BRIDGE_BACKOFF_MS: '150' };
for (const k of ['CLAUDE_PROJECT_DIR', 'FAKE_JOB_MODE', 'FAKE_KNOWN', 'FAKE_LAUNCHCTL_EXIT']) delete env[k];
const cli = (args, extra = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 30000 });
const lines = f => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const fromMac = () => lines(path.join(SRV, 'from-mac.jsonl'));
const toMac = o => fs.appendFileSync(path.join(SRV, 'to-mac.jsonl'), (typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
const wait = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); } };
const resultFor = id => wait(() => fromMac().find(o => o.t === 'result' && o.id === id));
const send = env => { toMac({ t: 'cmd', envelope: env }); return resultFor(env.command.id); };
const lastState = () => fromMac().filter(o => o.t === 'state').at(-1);
const log = () => lines(path.join(WK, 'remote-log.jsonl'));

test('the ssh argv is exactly the brief\'s; bad host, user or port values never reach ssh', () => {
  assert.deepEqual(sshArgv({ host: SERVER_HOST, port: 22, user: 'root' }, '/k/wk_bridge_ed25519'),
    ['-F', '/dev/null', '-T', '-i', '/k/wk_bridge_ed25519', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=15', '-p', '22', 'root@192.0.2.10']);
  for (const r of [{ host: '-oProxyCommand=sh', port: 22, user: 'root' }, { host: 'a b', port: 22, user: 'root' }, { host: 'h', port: 22, user: '-l' }, { host: 'h', port: 0, user: 'root' }, { host: 'h', port: 22, user: 'root@x' }])
    assert.throws(() => sshArgv(r, '/k'));
  assert.throws(() => sshArgv({ host: 'h', port: 22, user: 'root' }, 'relative/key'));
  const c = cli(['config', '--origin', 'https://panel.example.com', '--host', SERVER_HOST, '--user', 'root']); assert.equal(c.status, 0, c.stderr);
  const r = cli(['print-argv']); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [SERVER, ...sshArgv({ host: SERVER_HOST, port: 22, user: 'root' }, path.join(HOME, '.ssh', 'wk_bridge_ed25519'))]);
});

test('setup makes the key once (0600), writes remote.json switched off, warns about known_hosts, prints the server line', () => {
  const key = path.join(HOME, '.ssh', 'wk_bridge_ed25519');
  // no server command yet: setup refuses before it makes anything
  const none = cli(['setup']); assert.equal(none.status, 1);
  assert.equal(none.stderr.trim(), `Set the program the server runs for this ssh key first: node ${BIN} config --server-command PATH`);
  assert.ok(!fs.existsSync(key), 'no key made'); assert.deepEqual(lines(KGLOG), []);
  assert.equal(cli(['config', '--server-command', '/usr/local/sbin/example-bridge']).status, 0);
  const r = cli(['setup']); assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(HOME, '.ssh')).mode & 0o777, 0o700);
  assert.deepEqual(lines(KGLOG)[0], ['-t', 'ed25519', '-N', '', '-C', 'wk-remote', '-q', '-f', key]);
  assert.deepEqual(lines(KGLOG)[1], ['-F', SERVER_HOST]);
  assert.match(r.stdout, /host key is not in ~\/\.ssh\/known_hosts yet/);
  assert.equal(r.stdout.trim().split('\n').at(-1), 'restrict,command="/usr/local/sbin/example-bridge" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKEfake wk-remote');
  assert.ok(!r.stdout.includes('PRIVATE'));
  const rem = JSON.parse(fs.readFileSync(path.join(WK, 'remote.json'), 'utf8'));
  assert.equal(rem.enabled, false); assert.equal(rem.host, SERVER_HOST); assert.equal(rem.pace_stop_pct, 90);
  const r2 = cli(['setup'], { FAKE_KNOWN: '1' }); assert.equal(r2.status, 0);
  assert.match(r2.stdout, /already there \(kept\)/); assert.doesNotMatch(r2.stdout, /known_hosts/);
  assert.equal(lines(KGLOG).filter(a => a[0] === '-t').length, 1);
});

test('keys, trust, reject, enable and disable on the command line', () => {
  setRemote({ enabled: false });
  assert.match(cli(['keys']).stdout, /No phone keys yet/);
  const other = P.makePasskey('Stranger');
  assert.deepEqual(B.takeKey({ id: pk.id, spki: pk.spki, alg: -7, label: 'Test phone\u202e', registered_at: Date.UTC(2026, 10, 16, 18, 0) }), { ok: true, answered: false });
  assert.equal(B.takeKey({ id: other.id, spki: other.spki, alg: -7, label: 'Stranger' }).ok, true);
  assert.equal(B.takeKey({ id: 'short', spki: pk.spki, alg: -7 }).ok, false);
  assert.equal(B.takeKey({ id: P.makePasskey().id, spki: pk.spki, alg: -257 }).ok, false);
  assert.equal(B.takeKey({ id: P.makePasskey().id, spki: 'AAAA', alg: -7 }).ok, false);
  const k = JSON.parse(cli(['keys', '--json']).stdout);
  assert.deepEqual(k.pending.map(x => x.label), ['Test phone', 'Stranger']);
  assert.equal(fs.statSync(path.join(WK, 'remote-pending.json')).mode & 0o777, 0o600);
  const t = cli(['trust', pk.id.slice(0, 10)]); assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /^Trusted "Test phone" \(set up 16 Nov \d\d:\d\d\)\. Phone control is off\./);
  const rj = cli(['reject', other.id]); assert.equal(rj.status, 0); assert.match(rj.stdout, /Rejected "Stranger"/);
  assert.equal(cli(['trust', other.id]).status, 1);
  assert.match(cli(['trust', other.id]).stderr, /not waiting any more/);
  assert.equal(cli(['trust']).status, 2);
  const keys = L.readKeys();
  assert.deepEqual(keys.keys.map(x => x.id), [pk.id]); assert.deepEqual(keys.rejected, [other.id]);
  assert.equal(fs.statSync(path.join(WK, 'remote-keys.json')).mode & 0o777, 0o600);
  assert.deepEqual(L.readPending().keys, []);
  assert.equal(B.takeKey({ id: other.id, spki: other.spki, alg: -7 }).answered, true);   // a rejected key never waits again
  assert.match(cli(['enable']).stdout, /^Phone control is on\.$/m);
  assert.equal(L.readRemote().enabled, true);
  assert.match(cli(['disable']).stdout, /Phone control is off/); assert.equal(L.readRemote().enabled, false);
  // login: Face ID by default; only the Mac's command line switches to the panel's own sign-in
  assert.equal(L.readRemote().login, 'passkey'); assert.match(cli(['status']).stdout, /Login: Face ID/);
  assert.match(cli(['login', 'panel']).stdout, /panel's own sign-in/); assert.equal(L.readRemote().login, 'panel');
  assert.match(cli(['status']).stdout, /Login: the panel's own sign-in \(no Face ID\)/);
  assert.notEqual(cli(['login', 'nonsense']).status, 0);
  assert.match(cli(['login', 'passkey']).stdout, /Face ID on every command/); assert.equal(L.readRemote().login, 'passkey');
  assert.equal(cli(['frob']).status, 2); assert.equal(cli(['keys', '--nope']).status, 2);
});

test('install writes the launchd plist and starts it; a second install backs up the old one; uninstall moves it away', () => {
  const plist = path.join(HOME, 'Library', 'LaunchAgents', 'org.nexodyne.wk-remote.plist');
  const r = cli(['install']); assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(plist, 'utf8');
  assert.match(text, /<key>Label<\/key><string>org\.nexodyne\.wk-remote<\/string>/);
  assert.ok(text.includes(`<string>${process.execPath}</string><string>${BIN}</string><string>run</string>`));
  assert.ok(text.includes('<key>PATH</key>')); assert.ok(text.includes(`<key>WK_HOME</key><string>${WK}</string>`));
  assert.match(text, /<key>KeepAlive<\/key><true\/>/);
  const uid = process.getuid();
  assert.deepEqual(lines(LCTL), [['bootstrap', `gui/${uid}`, plist]]);
  const r2 = cli(['install']); assert.equal(r2.status, 0);
  assert.match(r2.stdout, /Moved the old org\.nexodyne\.wk-remote\.plist to ~\/\.wk\/backups\//);
  assert.deepEqual(lines(LCTL).slice(1), [['bootout', `gui/${uid}/org.nexodyne.wk-remote`], ['bootstrap', `gui/${uid}`, plist]]);
  assert.equal(fs.readdirSync(path.join(WK, 'backups')).length, 1);
  assert.match(cli(['status']).stdout, /Service: installed/);
  const bad = cli(['install'], { FAKE_LAUNCHCTL_EXIT: '5' }); assert.equal(bad.status, 1); assert.match(bad.stderr, /launchctl did not start phone control \(wk-remote\): fake launchctl: refused/);
  const u = cli(['uninstall']); assert.equal(u.status, 0); assert.match(u.stdout, /Stopped phone control \(wk-remote\) and moved/);
  assert.ok(!fs.existsSync(plist)); assert.equal(fs.readdirSync(path.join(WK, 'backups')).length, 3);
  assert.deepEqual(lines(LCTL).at(-1), ['bootout', `gui/${uid}/org.nexodyne.wk-remote`]);
  assert.match(cli(['uninstall']).stdout, /not installed/);
  assert.match(cli(['status']).stdout, /Service: not installed/);
});

test('fitModel cuts the oldest detail first and logs it; the change hash ignores the clock', () => {
  const big = 'x'.repeat(1000);
  const m = { now: 1, ledger: { top: Array(50).fill(big), wakeups: [] }, sessions: { sessions: Array(40).fill({ t: big }), more: 0 }, inbox: [], jobs: [{ id: 'j' }], phone: {}, mac: {}, bridge: {} };
  const logged = [];
  const out = B.fitModel(JSON.parse(JSON.stringify(m)), 60000, o => logged.push(o.what));
  assert.deepEqual(logged, ['ledger detail']); assert.equal(out.sessions.sessions.length, 40);
  const out2 = B.fitModel(JSON.parse(JSON.stringify(m)), 10000, o => logged.push(o.what));
  assert.deepEqual(logged.slice(1), ['ledger detail', 'session detail']); assert.equal(out2.sessions.sessions.length, 5); assert.equal(out2.sessions.more, 35);
  const out3 = B.fitModel({ ...JSON.parse(JSON.stringify(m)), questions: { items: Array(5000).fill(big) } }, 10000, () => {});
  assert.equal(out3.cut, true); assert.deepEqual(out3.jobs, [{ id: 'j' }]); assert.ok(!('questions' in out3));
  // P2-272 phase 3: the phone page shows the same status line as the panel, so the last cut keeps it
  const out4 = B.fitModel({ ...JSON.parse(JSON.stringify(m)), statusLine: 'All quiet.', statusState: 'ok', questions: { items: Array(5000).fill(big) } }, 10000, () => {});
  assert.equal(out4.cut, true); assert.equal(out4.statusLine, 'All quiet.'); assert.equal(out4.statusState, 'ok');
  const a = { now: 1, mac: { free_mb: 3401 }, bridge: { pushed_at: 1 }, x: 1 }, b = { now: 2, mac: { free_mb: 3420 }, bridge: { pushed_at: 9 }, x: 1 };
  assert.equal(B.modelHash(a), B.modelHash(b)); assert.notEqual(B.modelHash(a), B.modelHash({ ...b, x: 2 }));
});

test('the Mac refuses more than 30 phone commands a minute', async () => {
  setRemote({});
  const sent = [];
  const br = new B.Bridge({ send: o => { sent.push(o); return true; }, freeMbFn: () => 4000 });
  for (let i = 0; i < 31; i++) await br.command(P.viaPasskey(pk, P.command('ping')));
  const res = sent.filter(o => o.t === 'result');
  assert.equal(res.length, 31); assert.ok(res.slice(0, 30).every(o => o.ok && /^pong /.test(o.text)));
  assert.deepEqual([res[30].ok, res[30].text], [false, 'Too many commands from the phone. Wait a minute.']);
});

test('the link: hello, keys and state; commands checked and acted on; keys from the server; job events; size limit; reconnect', async () => {
  setRemote({});
  fs.rmSync(path.join(WK, 'remote-seen.jsonl'), { force: true });
  // a job from earlier, whose text has a secret, and one with a home path
  const jd = (id, last) => { const d = path.join(WK, 'jobs', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'prompt-1.txt'), 'Old work'); fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id, project: 'nexo', model: 'sonnet', mode: 'auto', from: 'phone', state: 'done', started_at: 1, ended_at: 2, cost_usd: 0, turns: 1, last_text: last, events: 0 })); };
  jd('J-20261101-0900-0001', `token sk-ant-${'b'.repeat(40)} there`); jd('J-20261101-0900-0002', `See ${HOME}/Projects/nexo/out.txt`);
  const child = spawn(process.execPath, [BIN, 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(r => child.on('exit', code => r(code)));
  try {
    await wait(() => lastState());
    const argv = lines(path.join(SRV, 'argv.jsonl'));
    assert.deepEqual(argv[0], sshArgv({ host: SERVER_HOST, port: 22, user: 'root' }, path.join(HOME, '.ssh', 'wk_bridge_ed25519')));
    const first = fromMac();
    assert.deepEqual(first.slice(0, 2).map(o => o.t), ['hello', 'keys']);
    assert.deepEqual(first[0], { t: 'hello', v: 1, wk: WK_VERSION, mac: 'this Mac' });
    assert.deepEqual(first[1].trusted.map(x => x.id), [pk.id]); assert.equal(first[1].trusted[0].spki, undefined);
    const m = lastState().model, raw = JSON.stringify(m);
    assert.ok(!('host' in m) && !('paths' in m)); assert.ok(!raw.includes(HOME)); assert.ok(!raw.includes('sk-ant-'));
    assert.match(WK_VERSION, /^\d+\.\d+\.\d+$/); assert.equal(m.bridge.version, WK_VERSION); assert.equal(typeof m.bridge.pushed_at, 'number');
    assert.deepEqual(Object.keys(m.mac).sort(), ['free_mb', 'low_ram', 'name']); assert.equal(m.mac.low_ram, false); assert.equal(m.mac.name, 'this Mac');
    // each question carries h, the hash of its text exactly as pushed
    const qh = n => m.questions.items.find(x => x.n === n).h;
    for (const x of m.questions.items) assert.equal(x.h, L.questionHash(x.text));
    assert.equal(qh('7'), B.pushedQuestionHash(D.findOpenQuestion(ORCH, '7').text, HOME));
    assert.deepEqual(m.phone.trusted.map(x => x.id), [pk.id]); assert.equal(m.phone.enabled, true);
    assert.ok(Array.isArray(m.jobs) && Array.isArray(m.projects)); assert.ok(m.jobs.every(j => !('tail' in j)));
    assert.equal(m.jobs.find(j => j.id === 'J-20261101-0900-0001').last_text, '[hidden]');
    assert.equal(m.jobs.find(j => j.id === 'J-20261101-0900-0002').last_text, 'See ~/Projects/nexo/out.txt');
    assert.ok(m.projects.some(p => p.key === 'nexo'));

    // decide kinds: ping by passkey, send by grant, a repeat of the same envelope returns the stored result and acts once
    const ping = await send(P.viaPasskey(pk, P.command('ping')));
    assert.equal(ping.ok, true); assert.match(ping.text, /^pong this Mac \d\d:\d\d$/);
    const g = P.makeGrant(pk);
    const sendEnv = P.viaGrant(g, P.command('send', { kind: 'recommendation', text: 'Try a shorter status line.' }));
    const s1 = await send(sendEnv); assert.equal(s1.ok, true); assert.match(s1.text, /Saved as a recommendation/);
    toMac({ t: 'cmd', envelope: sendEnv });
    await wait(() => fromMac().filter(o => o.t === 'result' && o.id === sendEnv.command.id).length === 2);
    const both = fromMac().filter(o => o.t === 'result' && o.id === sendEnv.command.id);
    assert.deepEqual(both[1], both[0]);
    assert.equal(D.readInbox(WK).filter(x => x.kind === 'recommendation').length, 1);
    assert.ok(log().some(o => o.ev === 'repeat' && o.id === sendEnv.command.id));
    // answer with the recommended text, the way the panel does; money needs "confirmed"
    const a7 = await send(P.viaGrant(g, P.command('answer', { n: '7', q: qh('7'), use_recommended: true })));
    assert.equal(a7.ok, true, a7.text); assert.deepEqual(nxCalls()[0], ['answer', '7', 'OK: yes.']);
    const a8 = await send(P.viaGrant(g, P.command('answer', { n: '8', q: qh('8'), use_recommended: true })));
    assert.equal(a8.ok, false); assert.match(a8.text, /money, legal wording or an account/); assert.equal(nxCalls().length, 1);
    const a8b = await send(P.viaGrant(g, P.command('answer', { n: '8', q: qh('8'), use_recommended: true, confirmed: true })));
    assert.equal(a8b.ok, true); assert.deepEqual(nxCalls()[1], ['answer', '8', 'OK: buy it.']);
    // refusals: not on the allowlist, a prompt kind by grant, a bad signature
    assert.equal((await send(P.viaGrant(g, P.command('shell', {})))).text, 'Not something the phone can do.');
    assert.equal((await send(P.viaGrant(g, P.command('remote-on', {})))).text, 'Not something the phone can do.');
    assert.equal((await send(P.viaGrant(g, P.command('job-start', { project: 'nexo', prompt: 'x', model: 'sonnet', mode: 'auto' })))).text, 'This needs a fresh Face ID on the phone.');
    const forged = P.viaPasskey(pk, P.command('stop-on'), { signWith: P.makePasskey().privateKey });
    assert.equal((await send(forged)).text, 'The signature is not valid.');
    assert.ok(!fs.existsSync(path.join(WK, 'KILL')));

    // a job from the phone: started through wk-job, its events pushed in batches, no tail in the state
    const js = await send(P.viaPasskey(pk, P.command('job-start', { project: 'nexo', prompt: 'Check the footer', model: 'haiku', mode: 'plan', max_turns: 9 })));
    assert.equal(js.ok, true, js.text); const jobId = /Started (J-\S+) in nexo/.exec(js.text)[1];
    const call = await wait(() => lines(path.join(WK, 'fake-claude.jsonl')).at(-1));
    assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'haiku'); assert.equal(call.argv[call.argv.indexOf('--max-turns') + 1], '9');
    assert.equal(JSON.parse(fs.readFileSync(path.join(WK, 'jobs', jobId, 'meta.json'), 'utf8')).from, 'phone');
    const evs = await wait(() => { const e = fromMac().filter(o => o.t === 'job' && o.job === jobId).flatMap(o => o.events); return e.some(x => x.type === 'result') ? e : null; });
    assert.deepEqual(evs.map(e => e.n), evs.map((_, i) => i + 1));
    assert.deepEqual(evs.map(e => e.type), ['prompt', 'init', 'text', 'tool', 'permission_denied', 'text', 'permission_denied', 'result']);
    const st = await wait(() => { const s = lastState(); const j = s && s.model.jobs.find(x => x.id === jobId); return j && j.state === 'waiting' ? j : null; });
    assert.equal(st.title, 'Check the footer'); assert.ok(!('tail' in st));
    const jr = await send(P.viaPasskey(pk, P.command('job-reply', { job: jobId, prompt: 'And the header' })));
    assert.equal(jr.ok, true, jr.text);
    await wait(() => lines(path.join(WK, 'fake-claude.jsonl')).some(c => c.stdin === 'And the header' && c.argv.includes('--resume')));

    // a key from the server waits for Trust; Trust on the Mac sends the keys message
    const phone2 = P.makePasskey('iPad');
    toMac({ t: 'key', key: { id: phone2.id, spki: phone2.spki, alg: -7, label: 'iPad', registered_at: Date.now() } });
    await wait(() => L.readPending().keys.some(k => k.id === phone2.id));
    await wait(() => { const s = lastState(); return s && s.model.phone.pending.some(k => k.id === phone2.id); });
    assert.ok(!JSON.stringify(lastState().model.phone).includes(phone2.spki));
    assert.equal(cli(['trust', phone2.id]).status, 0);
    await wait(() => fromMac().some(o => o.t === 'keys' && o.trusted.some(k => k.id === phone2.id)));
    // a key the Mac already answered gets the keys message again, so the server can drop it from its pending list
    const nKeys = fromMac().filter(o => o.t === 'keys').length;
    toMac({ t: 'key', key: { id: phone2.id, spki: phone2.spki, alg: -7, label: 'iPad' } });
    await wait(() => fromMac().filter(o => o.t === 'keys').length > nKeys);

    // a line over 2 MB is dropped and logged; the next line still works
    toMac(JSON.stringify({ t: 'cmd', pad: 'z'.repeat(2.1 * 1024 * 1024) }));
    const after = await send(P.viaPasskey(pk, P.command('ping')));
    assert.equal(after.ok, true);
    assert.ok(log().some(o => o.ev === 'line-dropped'));
    // phone control off from the phone; then every command is refused
    const off = await send(P.viaGrant(g, P.command('remote-off')));
    assert.equal(off.ok, true); assert.equal(L.readRemote().enabled, false);
    assert.equal((await send(P.viaPasskey(pk, P.command('ping')))).text, 'Phone control is off on the Mac.');
    await wait(() => lastState().model.phone.enabled === false);

    // the server goes away: the bridge connects again (backoff) and says hello again
    const hellos = fromMac().filter(o => o.t === 'hello').length;
    fs.writeFileSync(path.join(SRV, 'quit'), '');
    await wait(() => lines(path.join(SRV, 'argv.jsonl')).length === 2 && fromMac().filter(o => o.t === 'hello').length === hellos + 1);
    assert.ok(log().some(o => o.ev === 'link-closed'));
    assert.equal(JSON.parse(cli(['status', '--json']).stdout).connected, true);
  } finally {
    child.kill('SIGTERM');
  }
  assert.equal(await exited, 0, stderr);
  const s = JSON.parse(cli(['status', '--json']).stdout);
  assert.equal(s.connected, false); assert.equal(s.running, false);
  // review fix (W2, item 10): no hostname leaves the Mac, in any line
  const host = os.hostname(), all = JSON.stringify(fromMac());
  for (const h of [host, host.split('.')[0]]) if (h.length >= 4 && !/^localhost$/i.test(h)) assert.ok(!all.includes(h), 'the hostname left the Mac');
});

test('seen before acting: "started" is on disk before the action; a restart turns it into "interrupted", never "run again"', () => {
  const f = path.join(HOME, 'seen-unit.jsonl'), t = Date.now();
  const a = new L.Seen(f, t);
  assert.equal(a.start('cmd-aaaaaaaaaaaaaaaa', 'h1', t), true);
  assert.equal(a.get('cmd-aaaaaaaaaaaaaaaa').status, 'started');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  a.start('cmd-bbbbbbbbbbbbbbbb', 'h2', t); a.add('cmd-bbbbbbbbbbbbbbbb', { ok: true, text: 'Done.' }, 'h2', t);
  const b = new L.Seen(f, t + 1000);
  assert.deepEqual(b.interrupted, ['cmd-aaaaaaaaaaaaaaaa']);
  assert.deepEqual([b.get('cmd-aaaaaaaaaaaaaaaa').status, b.get('cmd-aaaaaaaaaaaaaaaa').ok, b.get('cmd-aaaaaaaaaaaaaaaa').text], ['interrupted', false, L.INTERRUPTED]);
  assert.deepEqual([b.get('cmd-bbbbbbbbbbbbbbbb').status, b.get('cmd-bbbbbbbbbbbbbbbb').ok], ['done', true]);
  assert.deepEqual(new L.Seen(f, t + 2000).interrupted, [], 'reported once: the file now says "interrupted"');
  // a seen file that cannot be written: start says no, so the bridge does not act
  const ro = path.join(HOME, 'ro'); fs.mkdirSync(ro, { mode: 0o500 });
  assert.equal(new L.Seen(path.join(ro, 'seen.jsonl'), t).start('cmd-cccccccccccccccc', 'h3', t), false);
});

test('a crash between seen and the action, then a re-delivery: the command acts zero times and the phone hears "Interrupted"', async () => {
  setRemote({});
  const SRV2 = path.join(HOME, 'srv-crash'); fs.mkdirSync(SRV2);
  const env2 = { ...env, FAKE_SERVER_DIR: SRV2 };
  const from2 = () => lines(path.join(SRV2, 'from-mac.jsonl')), to2 = o => fs.appendFileSync(path.join(SRV2, 'to-mac.jsonl'), JSON.stringify(o) + '\n');
  const recs = () => D.readInbox(WK).filter(x => x.kind === 'recommendation' && /Crash test line/.test(JSON.stringify(x))).length;
  const jobs0 = fs.existsSync(path.join(WK, 'jobs')) ? fs.readdirSync(path.join(WK, 'jobs')).length : 0, claude0 = lines(path.join(WK, 'fake-claude.jsonl')).length;
  const g = P.makeGrant(pk);
  const sendEnv = P.viaGrant(g, P.command('send', { kind: 'recommendation', text: 'Crash test line.' }));
  const jobEnv = P.viaPasskey(pk, P.command('job-start', { project: 'nexo', prompt: 'Crash test job', model: 'sonnet', mode: 'auto' }));
  const seenOf = id => lines(path.join(WK, 'remote-seen.jsonl')).filter(o => o.id === id);
  for (const e of [sendEnv, jobEnv]) {
    const child = spawn(process.execPath, [BIN, 'run'], { env: { ...env2, WK_BRIDGE_TEST_CRASH: 'after-seen' }, stdio: 'ignore' });
    const exited = new Promise(r => child.on('exit', (code, signal) => r(signal)));
    await wait(() => from2().some(o => o.t === 'state'));
    to2({ t: 'cmd', envelope: e });
    assert.equal(await exited, 'SIGKILL');
    assert.deepEqual(seenOf(e.command.id).map(o => o.status), ['started'], 'the id was on disk before the action');
  }
  assert.equal(recs(), 0); assert.equal(lines(path.join(WK, 'fake-claude.jsonl')).length, claude0);
  assert.equal(fs.existsSync(path.join(WK, 'jobs')) ? fs.readdirSync(path.join(WK, 'jobs')).length : 0, jobs0, 'no job was made');
  // restart without the crash: both are reported as interrupted, and re-delivering them acts zero times
  const child = spawn(process.execPath, [BIN, 'run'], { env: env2, stdio: 'ignore' });
  const exited = new Promise(r => child.on('exit', code => r(code)));
  try {
    const res = id => wait(() => { const x = from2().filter(o => o.t === 'result' && o.id === id); return x.length ? x : null; });
    for (const e of [sendEnv, jobEnv]) {
      const [r1] = await res(e.command.id);
      assert.deepEqual([r1.ok, r1.text], [false, L.INTERRUPTED]);
      to2({ t: 'cmd', envelope: e });
      const both = await wait(() => { const x = from2().filter(o => o.t === 'result' && o.id === e.command.id); return x.length === 2 ? x : null; });
      assert.deepEqual(both[1], both[0]);
      assert.deepEqual(seenOf(e.command.id).map(o => o.status), ['interrupted']);
    }
    assert.equal(recs(), 0); assert.equal(lines(path.join(WK, 'fake-claude.jsonl')).length, claude0);
    assert.equal(fs.existsSync(path.join(WK, 'jobs')) ? fs.readdirSync(path.join(WK, 'jobs')).length : 0, jobs0);
    assert.ok(log().some(o => o.ev === 'interrupted' && o.id === sendEnv.command.id));
    // the owner sends it again (a new id): it acts once
    const again = P.viaGrant(g, P.command('send', { kind: 'recommendation', text: 'Crash test line.' }));
    to2({ t: 'cmd', envelope: again });
    const [ra] = await res(again.command.id);
    assert.equal(ra.ok, true, ra.text); assert.equal(recs(), 1);
    assert.deepEqual(seenOf(again.command.id).map(o => o.status), ['started', 'done']);
  } finally {
    fs.writeFileSync(path.join(SRV2, 'quit'), '');
    if (await Promise.race([exited, new Promise(r => setTimeout(() => r('late'), 8000))]) === 'late') child.kill('SIGKILL');
  }
});

test('--transport-cmd replaces ssh; --once ends with the link', async () => {
  fs.writeFileSync(path.join(SRV, 'argv.jsonl'), '');
  const child = spawn(process.execPath, [BIN, 'run', '--once', '--transport-cmd', SERVER], { env: { ...env, WK_SSH_BIN: '/nonexistent/ssh' }, stdio: 'ignore' });
  const exited = new Promise(r => child.on('exit', code => r(code)));
  const n = fromMac().filter(o => o.t === 'hello').length;
  await wait(() => fromMac().filter(o => o.t === 'hello').length > n);
  assert.deepEqual(lines(path.join(SRV, 'argv.jsonl')), [[]]);
  fs.writeFileSync(path.join(SRV, 'quit'), '');
  assert.equal(await exited, 0);
});

test('no key yet: run says so and does not start ssh', async () => {
  const keyless = { ...env, HOME: path.join(HOME, 'other'), WK_HOME: path.join(HOME, 'other', '.wk') };
  fs.mkdirSync(keyless.WK_HOME, { recursive: true });
  fs.writeFileSync(path.join(keyless.WK_HOME, 'remote.json'), JSON.stringify({ origin: 'https://panel.example.com', rp_id: 'panel.example.com', host: SERVER_HOST, user: 'root' }));
  fs.writeFileSync(path.join(SRV, 'argv.jsonl'), '');
  const child = spawn(process.execPath, [BIN, 'run', '--once'], { env: keyless, stdio: 'ignore' });
  assert.equal(await new Promise(r => child.on('exit', r)), 0);
  assert.deepEqual(lines(path.join(SRV, 'argv.jsonl')), []);
  assert.match(spawnSync(process.execPath, [BIN, 'status'], { encoding: 'utf8', env: keyless }).stdout, /none yet \(run wk-remote setup\)/);
});

// ---------------------------------------------------------------- review fixes (W2)
test('300 unsigned or forged envelopes do not touch the phone budget: the next signed command runs', async () => {
  setRemote({});
  const sent = [];
  const br = new B.Bridge({ send: o => { sent.push(o); return true; }, freeMbFn: () => 4000 });
  for (let i = 0; i < 300; i++) {
    const env = i % 3 === 2 ? P.viaPasskey(pk, P.command('ping'), { signWith: P.makePasskey().privateKey }) : { command: P.command('ping'), auth: { via: i % 3 ? 'grant' : 'none' } };
    await br.command(env);
  }
  assert.equal(br.hits.length, 0);
  const res = sent.filter(o => o.t === 'result');
  assert.equal(res.length, 300); assert.ok(res.every(o => !o.ok && !/Too many/.test(o.text)));
  const signed = P.viaPasskey(pk, P.command('ping'));
  await br.command(signed);
  const last = sent.filter(o => o.t === 'result').at(-1);
  assert.equal(last.id, signed.command.id); assert.equal(last.ok, true); assert.match(last.text, /^pong this Mac /);
  assert.equal(br.hits.length, 1);
  // a verified command refused for the rate is seen: the same envelope later gets the same refusal, never a run
  const br2 = new B.Bridge({ send: o => { sent.push(o); return true; }, freeMbFn: () => 4000 });
  br2.hits = Array.from({ length: 30 }, () => Date.now());
  const late = P.viaPasskey(pk, P.command('stop-on'));
  await br2.command(late); br2.hits = [];
  await br2.command(late);
  const two = sent.filter(o => o.t === 'result' && o.id === late.command.id);
  assert.deepEqual(two.map(o => [o.ok, o.text]), [[false, 'Too many commands from the phone. Wait a minute.'], [false, 'Too many commands from the phone. Wait a minute.']]);
  assert.ok(!fs.existsSync(path.join(WK, 'KILL')));
});

test('an answer is bound to its question: a changed, gone or wrong-hash question is refused and never answered later', async () => {
  setRemote({});
  const Q = path.join(ORCH, 'QUESTIONS.md'), saved = fs.readFileSync(Q, 'utf8'), calls = nxCalls().length;
  fs.writeFileSync(Q, '# Questions\n\n- [ ] Q21 (2026-11-15 09:00, tab ?): T-3 Keep the old footer? Recommended: yes.\n- [ ] Q22 (2026-11-15 10:00, tab ?): T-4 Notes in ' + HOME + '/Projects/nexo/a.md ok? Recommended: yes.\n');
  try {
    const sent = [];
    const br = new B.Bridge({ send: o => { sent.push(o); return true; }, freeMbFn: () => 4000 });
    const resultOf = env => sent.filter(o => o.t === 'result' && o.id === env.command.id).at(-1);
    const model = await B.buildModel(L.readRemote());
    const h = n => model.questions.items.find(x => x.n === n).h;
    assert.match(h('21'), /^[0-9a-f]{16}$/);
    assert.equal(h('22'), L.questionHash(model.questions.items.find(x => x.n === '22').text));   // hashed after the home folder became ~
    assert.ok(model.questions.items.find(x => x.n === '22').text.includes('~/Projects/nexo/a.md'));
    // a wrong hash, and no hash at all
    const wrong = P.viaPasskey(pk, P.command('answer', { n: '21', q: 'ffffffffffffffff', use_recommended: true }));
    await br.command(wrong); assert.deepEqual([resultOf(wrong).ok, resultOf(wrong).text], [false, 'That question has changed. Open it again.']);
    const none = P.viaPasskey(pk, P.command('answer', { n: '21', use_recommended: true }));
    await br.command(none); assert.equal(resultOf(none).text, 'The command\'s details are not valid.');
    // the question's text changes after the phone saw it (a late delivery): refused; changed back, the same envelope stays refused
    const late = P.viaPasskey(pk, P.command('answer', { n: '21', q: h('21'), text: 'Yes, keep it.' }));
    fs.writeFileSync(Q, fs.readFileSync(Q, 'utf8').replace('Keep the old footer?', 'Delete the old footer?'));
    await br.command(late); assert.deepEqual([resultOf(late).ok, resultOf(late).text], [false, 'That question has changed. Open it again.']);
    fs.writeFileSync(Q, fs.readFileSync(Q, 'utf8').replace('Delete the old footer?', 'Keep the old footer?'));
    await br.command(late); assert.equal(resultOf(late).text, 'That question has changed. Open it again.');
    // a question that is gone
    const gone = P.viaPasskey(pk, P.command('answer', { n: '23', q: h('21'), use_recommended: true }));
    await br.command(gone); assert.equal(resultOf(gone).text, 'That question has changed. Open it again.');
    assert.equal(nxCalls().length, calls, 'nx was never called');
    // the right hash, from the pushed state, answers (the home-folder question too)
    const good = P.viaPasskey(pk, P.command('answer', { n: '22', q: h('22'), use_recommended: true }));
    await br.command(good); assert.equal(resultOf(good).ok, true, resultOf(good).text);
    assert.deepEqual(nxCalls().at(-1), ['answer', '22', 'OK: yes.']);
    // the check also runs on the question actions.js reads just before nx (no gap between check and answer)
    const A = (await import('node:module')).createRequire(import.meta.url)('../panel/src/actions.js');
    const r = await A.question(B.panelPaths(L.readRemote()), { cmd: 'answerQuestion', n: '21', useRecommended: true, expect: () => false, changedText: 'changed' });
    assert.deepEqual([r.ok, r.text], [false, 'changed']); assert.equal(nxCalls().length, calls + 1);
  } finally { fs.writeFileSync(Q, saved); }
});

// ---------------------------------------------------------------- P2-243: no built-in server
// A stranger's Mac: no remote.json. Nothing may reach any server until `wk-remote config` names one.
const freshWorld = name => {
  const h = path.join(HOME, name), wk = path.join(h, '.wk'); fs.mkdirSync(wk, { recursive: true });
  const e = { ...env, HOME: h, WK_HOME: wk, FAKE_KEYGEN_LOG: path.join(h, 'keygen.jsonl'), FAKE_LAUNCHCTL_LOG: path.join(h, 'launchctl.jsonl') };
  return { h, wk, e, cli: args => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: e, timeout: 30000 }) };
};

test('no server set: the defaults hold no server; status says so; setup, run, install, enable and print-argv refuse; disable still works', async () => {
  assert.deepEqual([L.REMOTE_DEFAULTS.origin, L.REMOTE_DEFAULTS.rp_id, L.REMOTE_DEFAULTS.host, L.REMOTE_DEFAULTS.user, L.REMOTE_DEFAULTS.server_command], ['', '', '', '', '']);
  assert.deepEqual(D.REMOTE_DEFAULTS, { ...L.REMOTE_DEFAULTS }, 'the panel\'s copy has the same shape and values');
  const w = freshWorld('stranger');
  const st = w.cli(['status']); assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /^Server: not set \(run wk-remote config --origin https:\/\/\.\.\. --host \.\.\.\)\.$/m);
  assert.equal(JSON.parse(w.cli(['status', '--json']).stdout).server, false);
  const msg = `Phone control needs a companion server (not published yet). If you run one: node ${BIN} config --origin https://... --host ...`;
  for (const cmd of [['setup'], ['install'], ['enable'], ['print-argv'], ['run', '--once']]) {
    const r = w.cli(cmd); assert.equal(r.status, 1, cmd.join(' ')); assert.equal(r.stderr.trim(), msg, cmd.join(' '));
  }
  assert.ok(!fs.existsSync(path.join(w.h, '.ssh', 'wk_bridge_ed25519')), 'setup made no key');
  assert.deepEqual(lines(path.join(w.h, 'keygen.jsonl')), []); assert.deepEqual(lines(path.join(w.h, 'launchctl.jsonl')), []);
  assert.ok(!fs.existsSync(path.join(w.h, 'Library', 'LaunchAgents', 'org.nexodyne.wk-remote.plist')), 'install wrote no plist');
  assert.equal(L.readJsonFile(path.join(w.wk, 'remote.json'), {}).enabled, undefined, 'enable switched nothing on');
  const off = w.cli(['disable']); assert.equal(off.status, 0, off.stderr); assert.match(off.stdout, /Phone control is off/);
  // the link itself: a run started some other way (an old launchd agent) waits, opens no transport and says why
  fs.writeFileSync(path.join(SRV, 'argv.jsonl'), '');
  const B2 = await import('../bin/wk-remote.mjs?no-server');
  const before = { HOME: process.env.HOME, WK_HOME: process.env.WK_HOME };
  process.env.WK_HOME = w.wk;
  try {
    assert.equal(await B2.run({ once: true, transportCmd: SERVER }), 0);
    assert.deepEqual(lines(path.join(SRV, 'argv.jsonl')), [], 'no transport was started');
    assert.equal(L.readJsonFile(path.join(w.wk, 'remote-status.json'), {}).last_error, msg);
  } finally { process.env.WK_HOME = before.WK_HOME; }
  // a server without an ssh user: the link still waits, with its own plain message
  fs.writeFileSync(path.join(w.wk, 'remote.json'), JSON.stringify({ origin: 'https://panel.example.com', rp_id: 'panel.example.com', host: SERVER_HOST }));
  const nu = w.cli(['print-argv']); assert.equal(nu.status, 1); assert.equal(nu.stderr.trim(), `Set the ssh user first: node ${BIN} config --user NAME`);
});

test('wk-remote config checks every value, writes remote.json through writeRemote and prints what it set', () => {
  const w = freshWorld('configured'), file = path.join(w.wk, 'remote.json');
  const usage = w.cli(['config']); assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: wk-remote config --origin <https URL> --host <name or IP> \[--port N\] \[--user NAME\] \[--rp-id DOMAIN\] \[--server-command PATH\]/);
  const refused = [
    [['--origin', 'http://panel.example.com', '--host', SERVER_HOST], /--origin must be an https address/],
    [['--origin', 'https://panel.example.com/w', '--host', SERVER_HOST], /--origin must be an https address/],
    [['--origin', 'https://user:pw@panel.example.com', '--host', SERVER_HOST], /--origin must be an https address/],
    [['--origin', 'not a url', '--host', SERVER_HOST], /--origin must be an https address/],
    [['--origin', 'https://panel.example.com'], /needs both --origin and --host/],
    [['--host', SERVER_HOST], /needs both --origin and --host/],
    [['--origin', 'https://panel.example.com', '--host', '-oProxyCommand=sh'], /--host must be a host name/],
    [['--origin', 'https://panel.example.com', '--host', 'a;b'], /--host must be a host name/],
    [['--origin', 'https://panel.example.com', '--host', SERVER_HOST, '--port', '0'], /--port must be a number from 1 to 65535/],
    [['--origin', 'https://panel.example.com', '--host', SERVER_HOST, '--port', '65536'], /--port must be/],
    [['--origin', 'https://panel.example.com', '--host', SERVER_HOST, '--port', '22x'], /--port must be/],
    [['--origin', 'https://panel.example.com', '--host', SERVER_HOST, '--user', 'Root'], /--user must be a user name/],
    [['--origin', 'https://panel.example.com', '--host', SERVER_HOST, '--user', '-l'], /--user must be a user name/],
    [['--origin', 'https://panel.example.com', '--host', SERVER_HOST, '--rp-id', 'other.example.com'], /--rp-id must be the origin's host name \(panel\.example\.com\) or a parent domain of it/],
    [['--origin', 'https://panel.example.com', '--host', SERVER_HOST, '--rp-id', 'com'], /--rp-id must be the origin's host name/],
    [['--origin', 'https://panel.example.com', '--host', SERVER_HOST, '--rp-id', 'ample.com'], /--rp-id must be the origin's host name/],
    [['--origin', 'https://panel.example.com', '--host', SERVER_HOST, '--nope'], /unknown option --nope/],
    ...['usr/local/sbin/example-bridge', '/', '/usr/local/sbin/x" ; rm -rf ~', '/usr/local/sbin/a b', '/usr/local/sbin/$(id)', '/usr/local/sbin/x,y', '/usr/local/sbin/é']
      .map(c => [['--origin', 'https://panel.example.com', '--host', SERVER_HOST, '--server-command', c], /--server-command must be an absolute path \(letters, digits, dots, underscores, dashes and slashes only\)/]),
  ];
  for (const [args, re] of refused) { const r = w.cli(['config', ...args]); assert.equal(r.status, 2, args.join(' ')); assert.match(r.stderr, re, args.join(' ')); }
  assert.ok(!fs.existsSync(file), 'a refused config writes nothing');
  const ok = w.cli(['config', '--origin', 'https://panel.example.com/', '--host', SERVER_HOST, '--user', 'root']); assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.stdout.trim().split('\n'), ['Server set in ~/.wk/remote.json:', '  origin https://panel.example.com (passkeys for panel.example.com)', '  ssh root@192.0.2.10, port 22', '  server command not set yet (add --server-command PATH)', 'Phone control is off.']);
  let rem = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([rem.origin, rem.rp_id, rem.host, rem.port, rem.user, rem.enabled, rem.key, rem.max_jobs], ['https://panel.example.com', 'panel.example.com', SERVER_HOST, 22, 'root', false, '~/.ssh/wk_bridge_ed25519', 2]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(w.cli(['status']).stdout, /^Server: https:\/\/panel\.example\.com, ssh root@192\.0\.2\.10\.$/m);
  // later changes: one value at a time; a parent domain as RP ID; other settings kept
  fs.writeFileSync(file, JSON.stringify({ ...rem, enabled: true, orchestration: '/x/orchestration' }));
  assert.equal(w.cli(['config', '--port', '2222']).status, 0);
  assert.equal(w.cli(['config', '--origin', 'https://w.panel.example.com', '--rp-id', 'Example.com']).status, 0);
  rem = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([rem.origin, rem.rp_id, rem.host, rem.port, rem.user, rem.enabled, rem.orchestration], ['https://w.panel.example.com', 'example.com', SERVER_HOST, 2222, 'root', true, '/x/orchestration']);
  assert.equal(w.cli(['config', '--rp-id', 'panel.example.com']).status, 0, 'a parent of w.panel.example.com');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rp_id, 'panel.example.com');
  assert.match(w.cli(['status']).stdout, /^Server: https:\/\/w\.panel\.example\.com, ssh root@192\.0\.2\.10 port 2222\.$/m);
  const argv = JSON.parse(w.cli(['print-argv']).stdout);
  assert.deepEqual(argv.slice(-3), ['-p', '2222', 'root@192.0.2.10']);
  // the server's forced command: its own field, kept by later changes
  const sc = w.cli(['config', '--server-command', '/usr/local/sbin/example-bridge']); assert.equal(sc.status, 0, sc.stderr);
  assert.ok(sc.stdout.includes('  server command /usr/local/sbin/example-bridge\n'));
  assert.equal(w.cli(['config', '--port', '22']).status, 0);
  rem = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([rem.server_command, rem.port, rem.origin], ['/usr/local/sbin/example-bridge', 22, 'https://w.panel.example.com']);
  // a hand-edited value that could break out of command="..." never reaches the printed line
  fs.writeFileSync(file, JSON.stringify({ ...rem, server_command: '/x" ,command="/bin/sh' }));
  const bad = w.cli(['setup']); assert.equal(bad.status, 1); assert.match(bad.stderr, /server_command in remote\.json must be an absolute path/);
  assert.ok(!fs.existsSync(path.join(w.h, '.ssh', 'wk_bridge_ed25519')), 'no key made');
});

test('the orchestration folder comes only from remote.json: no built-in default, even when the old default folder exists', () => {
  const OLD = 'nexo' + 'dyne';   // the built-in default before 0.6.1: ~/Projects/<this name>/orchestration
  const d = path.join(HOME, 'Projects', OLD, 'orchestration'); fs.mkdirSync(d, { recursive: true });
  try {
    assert.equal(B.orchestrationDir({}), '');
    assert.equal(B.orchestrationDir({ orchestration: '' }), '');
    assert.equal(B.orchestrationDir({ orchestration: '~/Projects/nexo/orchestration' }), ORCH, '~ expands');
    assert.equal(B.panelPaths({}).orchestrationDir, '');
  } finally { fs.rmSync(path.join(HOME, 'Projects', OLD), { recursive: true }); }
});

nodeTest.after(() => {
  // the job started from the "phone" ends on its own; stop any that still runs
  try { for (const id of fs.readdirSync(path.join(WK, 'jobs'))) spawnSync(process.execPath, [path.resolve('bin/wk-job.mjs'), 'stop', id], { env, encoding: 'utf8' }); } catch { /* none */ }
});
