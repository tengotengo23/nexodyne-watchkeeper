// P2-272: the Stop switch in wk-bridge. While $WK_HOME/KILL exists, no remote action runs ("Stop switch is on");
// ping (a status read), the switch itself and stopping a job still work, and status reads keep working.
// Same harness as test/bridge.test.mjs: a temp HOME and WK_HOME; nothing reaches a server, the real ~/.wk or ~/.ssh.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-p2-272-bridge-')));
const WK = path.join(HOME, '.wk');
process.env.HOME = HOME; process.env.WK_HOME = WK;
fs.mkdirSync(WK, { recursive: true });
const B = await import('../bin/wk-bridge.mjs');
const L = await import('../bin/remote-lib.mjs');
const P = await import('./fixtures/passkey.mjs');

const ORCH = path.join(HOME, 'Projects', 'nexo', 'orchestration');
fs.mkdirSync(ORCH, { recursive: true }); fs.mkdirSync(path.join(HOME, 'Projects', 'nexo', '.git'));
fs.writeFileSync(path.join(ORCH, 'QUESTIONS.md'), '# Questions\n\n- [ ] Q7 (2026-11-14 09:00, tab ?): T-1 Show the pace bar first? Recommended: yes.\n');
const nxLog = path.join(ORCH, 'argv.jsonl');
fs.writeFileSync(path.join(ORCH, 'nx'), "#!/usr/bin/env node\nconst fs=require('fs'),p=require('path');fs.appendFileSync(p.join(__dirname,'argv.jsonl'),JSON.stringify(process.argv.slice(2))+'\\n');console.log('ok')\n", { mode: 0o755 });
fs.writeFileSync(path.join(WK, 'remote.json'), JSON.stringify({ enabled: true, origin: P.ORIGIN, rp_id: P.RP, host: '192.0.2.10', user: 'root', orchestration: ORCH, task_repo: path.join(HOME, 'Projects', 'nexo') }));
const pk = P.makePasskey('Test phone');
L.writeKeys(P.trusted(pk));
const KILL = path.join(WK, 'KILL');
const SUG = 'S-20261123-120000-abcd', TASK_KIND = L.TASK_KINDS ? L.TASK_KINDS[0] : 'feature';

const bridge = () => { const sent = []; const br = new B.Bridge({ send: o => { sent.push(o); return true; }, freeMbFn: () => 4000 }); return { br, sent }; };
const run = async (br, sent, kind, args) => { const env = P.viaPasskey(pk, P.command(kind, args)); await br.command(env); return sent.filter(o => o.t === 'result' && o.id === env.command.id).at(-1); };

test('Stop switch on: answer, later, suggestion, task and job-start are refused with "Stop switch is on"; nothing is written', async () => {
  fs.writeFileSync(KILL, 'stop\n');
  try {
    const { br, sent } = bridge();
    for (const [kind, args] of [['later', { n: '7' }], ['answer', { n: '7', q: 'ffffffffffffffff', use_recommended: true }],
      ['suggestion', { id: SUG, choice: 'ok', confirmed: true }], ['task', { title: 'Do something', text: '', kind: TASK_KIND }], ['job-start', { project: 'nexo', prompt: 'x', model: 'sonnet', mode: 'auto' }]]) {
      const r = await run(br, sent, kind, args);
      assert.ok(r, `a result for ${kind}`);
      assert.equal(r.ok, false, kind);
      assert.match(r.text, /Stop switch is on/, kind);
    }
    assert.ok(!fs.existsSync(nxLog), 'nx was never called');
    assert.ok(!fs.existsSync(path.join(WK, 'jobs')), 'no job started');
  } finally { fs.rmSync(KILL, { force: true }); }
});

test('Stop switch on: ping still answers, status reads still work, and stop-off lifts it so actions run again', async () => {
  fs.writeFileSync(KILL, 'stop\n');
  const { br, sent } = bridge();
  const ping = await run(br, sent, 'ping');
  assert.equal(ping.ok, true); assert.match(ping.text, /^pong this Mac /);
  const st = B.statusLines();
  assert.ok(Array.isArray(st.lines) && st.lines.length > 0 && st.o.enabled === true, 'status lines still come back');
  const on = await run(br, sent, 'stop-on');
  assert.equal(on.ok, true); assert.ok(fs.existsSync(KILL));
  const off = await run(br, sent, 'stop-off');
  assert.equal(off.ok, true, off.text);
  assert.ok(!fs.existsSync(KILL), 'stop-off removed the kill file');
  const later = await run(br, sent, 'later', { n: '7' });
  assert.doesNotMatch(later.text, /Stop switch is on/);
});

test('Stop switch off: the gate stays out of the way (ping and later behave as before)', async () => {
  fs.rmSync(KILL, { force: true });
  assert.equal(B.stopSwitchOn(B.panelPaths({})), false);
  const { br, sent } = bridge();
  assert.equal((await run(br, sent, 'ping')).ok, true);
  fs.writeFileSync(KILL, 'x'); assert.equal(B.stopSwitchOn(B.panelPaths({})), true); fs.rmSync(KILL, { force: true });
});
