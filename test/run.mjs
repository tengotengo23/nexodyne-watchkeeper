import { spawnSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert'; import crypto from 'node:crypto';
const B = path.resolve('bin'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
const run = (s, input, args = [], env = {}) => spawnSync('node', [path.join(B, s), ...args], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: tmp, CLAUDE_PLUGIN_ROOT: path.resolve('.'), HOME: path.join(tmp, 'home'), WK_POLICY_SHA256: '', ...env } });
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const guard = ti => run('wk-guard.mjs', { tool_name: ti.command ? 'Bash' : 'Read', tool_input: ti });
t('planted private file is blocked', () => assert.equal(guard({ file_path: '/x/proj/.env' }).status, 2));
t('key dir blocked', () => assert.equal(guard({ file_path: '/Users/a/Developer/keys/azure.txt' }).status, 2));
t('shell cat of .env blocked', () => assert.equal(guard({ command: 'cat .env' }).status, 2));
t('normal read allowed', () => assert.equal(guard({ file_path: '/x/proj/src/app.js' }).status, 0));
t('hard reset blocked', () => assert.equal(guard({ command: 'git reset --hard HEAD~1' }).status, 2));
t('secret in write blocked', () => assert.equal(run('wk-guard.mjs', { tool_name: 'Write', tool_input: { file_path: '/x/a.js', content: 'k="sk_live_' + 'a'.repeat(24) + '"' } }).status, 2));
t('project override cannot loosen or break deny lists', () => { fs.mkdirSync(path.join(tmp, '.wk'), { recursive: true }); fs.writeFileSync(path.join(tmp, '.wk/gates.json'), '{"denyPathGlobs":"none","denyBash":[1],"secretPatterns":[]}'); assert.equal(guard({ file_path: '/x/.env' }).status, 2); assert.equal(guard({ file_path: '/x/p/.wk/gates.json' }).status, 2); fs.rmSync(path.join(tmp, '.wk/gates.json')); });
const tr = path.join(tmp, 'tr.jsonl'); const say = x => fs.writeFileSync(tr, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: x }] } }) + '\n');
const gate = (extra = {}) => run('wk-evidence.mjs', { transcript_path: tr, ...extra }, ['gate']);
t('planted false done is blocked', () => { say('All done, tests pass.'); assert.match(gate().stdout, /block/); });
t('retry cap: stop_hook_active passes', () => assert.equal(gate({ stop_hook_active: true }).stdout, ''));
t('honest gap allowed', () => { say('Done, but tests skipped: no suite here.'); assert.equal(gate().stdout, ''); });
t('failing run recorded then blocks', () => { run('wk-evidence.mjs', { tool_input: { command: 'npm test' }, tool_response: { stdout: 'WK_EXIT=1', stderr: '' } }, ['record']); say('Fixed and tested.'); assert.match(gate().stdout, /failed/); });
t('passing run lets done through', () => { run('wk-evidence.mjs', { tool_input: { command: 'wk-run npm test' }, tool_response: { stdout: 'WK_EXIT=0 WK_LOG=x', stderr: '' } }, ['record']); assert.equal(gate().stdout, ''); });
t('project .wk/ ignores itself: the first log writes .wk/.gitignore ("*"); one the user changed is kept', () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-gi-')), env = { CLAUDE_PROJECT_DIR: p };
  assert.equal(run('wk-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~1' } }, [], env).status, 2);
  assert.ok(fs.existsSync(path.join(p, '.wk/blocked.log')), 'the refusal was logged in the project');
  assert.equal(fs.readFileSync(path.join(p, '.wk/.gitignore'), 'utf8'), '*\n');
  const q = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-gi-')); fs.mkdirSync(path.join(q, '.wk')); fs.writeFileSync(path.join(q, '.wk/.gitignore'), '*.log\n');
  run('wk-evidence.mjs', { tool_input: { command: 'npm test' }, tool_response: { stdout: 'WK_EXIT=0', stderr: '' } }, ['record'], { CLAUDE_PROJECT_DIR: q });
  assert.ok(fs.readdirSync(path.join(q, '.wk/evidence')).length, 'evidence recorded');
  assert.equal(fs.readFileSync(path.join(q, '.wk/.gitignore'), 'utf8'), '*.log\n', 'kept as the user left it');
});
t('non-claim passes', () => { say('Here is the plan.'); assert.equal(gate().stdout, ''); });
t('start hook silent without worklog', () => assert.equal(run('wk-start.mjs', {}).stdout, ''));
t('start hook capped', () => { fs.mkdirSync(path.join(tmp, 'worklog'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'worklog/STATE.md'), '## Now\n' + 'x'.repeat(900) + '\n'.repeat(1) + '- b\n'.repeat(20)); const o = run('wk-start.mjs', {}, [], { WK_START_BYTES: '500' }).stdout; assert.ok(o.length <= 502 && o.includes('Now')); });
t('optimise dry run diff, apply backs up', () => { const f = path.join(tmp, 's.json'); fs.writeFileSync(f, '{"autoCompactWindow":1000000}'); const r = spawnSync('node', [path.join(B, 'wk-optimise.mjs'), '--file', f, '--apply'], { encoding: 'utf8' }); assert.match(r.stdout, /applied/); assert.equal(JSON.parse(fs.readFileSync(f)).env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '65'); assert.ok(fs.readdirSync(tmp).some(x => x.includes('wk-backup'))); });
t('ledger spike (the dollar pace is gone: wk-ledger pace now reads the meter, see test/ledger.pace.test.mjs)', () => { const l = path.join(tmp, 'p.jsonl'), env = { ...process.env, WK_LEDGER: l, WK_TZ_UTC: '1', WK_NOW: '2026-11-08T12:00:00Z', WK_WEEKLY_USD: '7' };
  const row = (d, c) => JSON.stringify({ at: d + 'T10:00:00Z', cost_usd: c }); fs.writeFileSync(l, [row('2026-11-05', 1), row('2026-11-06', 1), row('2026-11-07', 1), row('2026-11-08', 0.5)].join('\n'));
  const run = c => spawnSync('node', [path.join(B, 'wk-ledger.mjs'), c], { encoding: 'utf8', env });
  assert.equal(run('spike').status, 0);
  fs.appendFileSync(l, '\n' + row('2026-11-08', 0.6)); assert.equal(run('spike').status, 0);
  fs.appendFileSync(l, '\n' + row('2026-11-08', 3)); assert.equal(run('spike').status, 3); });
t('ledger add + p80 stop + context', () => { const env = { ...process.env, WK_LEDGER: path.join(tmp, 'l.jsonl') }; let r = spawnSync('node', [path.join(B, 'wk-ledger.mjs'), 'add', 'T-1', '1'], { input: JSON.stringify({ total_cost_usd: 3, num_turns: 4, usage: { input_tokens: 5 } }), encoding: 'utf8', env }); assert.equal(r.status, 3);
  fs.writeFileSync(path.join(tmp, 'c.jsonl'), [100000, 300000, 400000].map(c => JSON.stringify({ message: { usage: { input_tokens: 1, cache_read_input_tokens: c } } })).join('\n')); r = spawnSync('node', [path.join(B, 'wk-ledger.mjs'), 'context', path.join(tmp, 'c.jsonl')], { encoding: 'utf8' }); assert.match(r.stdout, /WARN/); });
t('wk-run reports failures only', () => { const r = spawnSync(path.join(B, 'wk-run'), ['sh', '-c', 'echo fine; echo "FAIL x"; exit 1'], { cwd: tmp, encoding: 'utf8' }); assert.equal(r.status, 1); assert.match(r.stdout, /WK_EXIT=1/); });
t('role agents carry window, turns, model', () => { for (const a of ['scout', 'builder', 'reviewer']) { const f = fs.readFileSync(path.resolve('agents', a + '.md'), 'utf8'); for (const k of ['model:', 'effort:', 'maxTurns:', 'autoCompactWindow:']) assert.ok(f.includes(k), a + ' ' + k); } });
// ---- F27: lane privacy ----
const snap = path.join(tmp, 'snapshots'); fs.mkdirSync(snap, { recursive: true });
fs.writeFileSync(path.join(snap, 'totals.json'), '{"members":412,"quizTakers":3321}');
fs.writeFileSync(path.join(snap, 'leak.json'), '{"email":"mum@gmail.com","first_name":"Nino"}');
fs.writeFileSync(path.join(tmp, 'secret-rows.txt'), 'WK-PRIVATE-CANARY anna@gmail.com');
// the lane always runs pinned: bin/wk-lane exports WK_POLICY_SHA256 at launch, so these calls carry the same env pin
const PIN = crypto.createHash('sha256').update(fs.readFileSync(path.resolve('config/gates.json'))).digest('hex');
const lane = (ev) => run('wk-guard.mjs', ev, [], { WK_LANE: '1', WK_LANE_ROOTS: snap, WK_POLICY_SHA256: PIN });
t('lane reads an aggregated snapshot', () => assert.equal(lane({ tool_name: 'Read', tool_input: { file_path: path.join(snap, 'totals.json') } }).status, 0));
t('lane blocks a planted private file outside the roots', () => assert.equal(lane({ tool_name: 'Read', tool_input: { file_path: path.join(tmp, 'secret-rows.txt') } }).status, 2));
t('lane blocks private rows even inside the roots', () => assert.match(lane({ tool_name: 'Read', tool_input: { file_path: path.join(snap, 'leak.json') } }).stderr, /private rows/));
t('lane blocks db folders, sqlite and shell reads', () => { assert.equal(lane({ tool_name: 'Read', tool_input: { file_path: path.join(snap, 'data/x.json') } }).status, 2); assert.equal(lane({ tool_name: 'Bash', tool_input: { command: 'sqlite3 /srv/x.db .dump' } }).status, 2); assert.equal(lane({ tool_name: 'Bash', tool_input: { command: 'cat ' + path.join(tmp, 'secret-rows.txt') } }).status, 2); });
t('lane refuses missing path, relative shell path, interpreter, pipe, symlink escape', () => {
  assert.equal(lane({ tool_name: 'Grep', tool_input: { pattern: 'gmail' } }).status, 2);
  assert.equal(lane({ tool_name: 'Glob', tool_input: { pattern: '**/*.txt' } }).status, 2);
  assert.equal(lane({ tool_name: 'Bash', tool_input: { command: 'cat ../secret-rows.txt' } }).status, 2);
  assert.equal(lane({ tool_name: 'Bash', tool_input: { command: 'node -e "1"' } }).status, 2);
  assert.equal(lane({ tool_name: 'Bash', tool_input: { command: 'cat ' + path.join(snap, 'totals.json') + ' | sh' } }).status, 2);
  assert.equal(lane({ tool_name: 'Bash', tool_input: { command: 'jq . ' + path.join(snap, 'totals.json') } }).status, 0);
  const T = path.join(snap, 'totals.json'), bash = c => lane({ tool_name: 'Bash', tool_input: { command: c } }).status;
  assert.equal(bash('cat totals.json'), 2); assert.equal(bash('cat 5'), 2); assert.equal(bash('head -n 5 ' + T), 0); assert.equal(bash('head -n ../x ' + T), 2);
  assert.equal(bash('jq --rawfile a /etc/hosts . ' + T), 2); assert.equal(bash('jq -f /etc/x ' + T), 2); assert.equal(bash('grep --file=/etc/hosts ' + T), 2);
  assert.equal(bash('grep members ' + T), 0); assert.equal(bash('grep members'), 2); assert.equal(bash('ls'), 2);
  fs.symlinkSync(path.join(tmp, 'secret-rows.txt'), path.join(snap, 'link.txt'));
  assert.equal(lane({ tool_name: 'Read', tool_input: { file_path: path.join(snap, 'link.txt') } }).status, 2); });
t('lane blocks sending private data in a write', () => assert.equal(lane({ tool_name: 'Write', tool_input: { file_path: path.join(snap, 'o.md'), content: 'mail mum@gmail.com' } }).status, 2));
t('lane with no roots fails closed', () => assert.equal(run('wk-guard.mjs', { tool_name: 'Read', tool_input: { file_path: path.join(snap, 'totals.json') } }, [], { WK_LANE: '1', WK_LANE_ROOTS: '' }).status, 2));
t('lane launcher: environment holds no personal rows or login', () => { const r = spawnSync('node', [path.join(B, 'wk-lane'), '--check-env'], { encoding: 'utf8', env: { ...process.env, DB_ROWS: 'anna@gmail.com', STRIPE_SECRET_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'y' } }); const keys = JSON.parse(r.stdout); for (const k of ['DB_ROWS', 'STRIPE_SECRET_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.ok(!keys.includes(k), k); assert.ok(keys.includes('WK_LANE')); });
t('lane launcher: pre-send scanner stops a private prompt, passes a clean one', () => { const pf = path.join(tmp, 'p.txt'); fs.writeFileSync(pf, 'Summarise: contact anna@gmail.com'); let r = spawnSync('node', [path.join(B, 'wk-lane'), '--roots', snap, '--', pf], { encoding: 'utf8', env: { ...process.env, WK_CLAUDE: '/bin/echo' } }); assert.equal(r.status, 2); fs.writeFileSync(pf, 'Summarise totals.'); r = spawnSync('node', [path.join(B, 'wk-lane'), '--roots', snap, '--', pf], { encoding: 'utf8', env: { ...process.env, WK_CLAUDE: '/bin/echo' } }); assert.equal(r.status, 0); });
{ const S = await import(path.resolve('bin/wk-snapshot.mjs')); const now = new Date('2026-11-08T12:00:00Z'), ts = d => Math.floor(now / 1000) - d * 86400, fake = rows => async ep => rows[ep] || [];
  const rows = { charges: [{ paid: true, currency: 'USD', amount: 1500, created: ts(2) }, { paid: true, currency: 'usd', amount: 12000, created: ts(20) }, { paid: true, currency: 'eur', amount: 99, created: ts(1) }, { paid: false, currency: 'usd', amount: 500, created: ts(1) }], subscriptions: [{ created: ts(3) }, { created: ts(10) }], refunds: [{ created: ts(5) }] };
  const s = await S.buildSnapshot({ stripeFn: fake(rows), now }); assert.deepEqual(s.stripe.charges.last_7d, { usd: { count: 1, gross: 15 }, eur: { count: 1, gross: 0.99 } }); assert.deepEqual(s.stripe.charges.last_28d.usd, { count: 2, gross: 135 }); assert.equal(s.stripe.subscriptions.new_last_7d, 1); assert.equal(s.stripe.subscriptions.new_last_28d, 2); assert.equal(s.stripe.refunds.last_28d, 1); assert.equal(s.schema_version, 1); n++; console.log('ok snapshot totals right');
  const d = path.join(tmp, 'snap'); const f = S.writeSnapshot(s, d); assert.ok(fs.existsSync(f)); n++; console.log('ok snapshot written');
  const bad = await S.buildSnapshot({ stripeFn: fake({ ...rows, charges: [{ paid: true, currency: 'usd', amount: 1, created: ts(1), receipt_email: 'x@gmail.com' }] }), now }); bad.note = 'mum@gmail.com'; const d2 = path.join(tmp, 'snap2'); assert.throws(() => S.writeSnapshot(bad, d2), /refused/); assert.ok(!fs.existsSync(d2)); assert.throws(() => S.writeSnapshot({ ...s, stripe: { customer: 5 } }, d2), /denied/); assert.ok(!fs.existsSync(d2)); n++; console.log('ok snapshot planted email aborts, no file');
  const d3 = path.join(tmp, 'snap3'); const r = spawnSync('node', [path.join(B, 'wk-snapshot.mjs')], { encoding: 'utf8', env: { ...process.env, STRIPE_RESTRICTED_KEY: '', WK_SNAPSHOT_DIR: d3 } }); assert.equal(r.status, 0); const j = JSON.parse(fs.readFileSync(path.join(d3, fs.readdirSync(d3)[0]))); assert.equal(j.stripe, null); assert.deepEqual(j.missing, ['stripe_key']); n++; console.log('ok snapshot no key gives stripe:null');
  const vf = path.join(tmp, 'v.json'); fs.writeFileSync(vf, '{"example.com":{"visitors":120,"ip":"1.2.3.4"},"app":55}'); assert.deepEqual(S.visitorTotals(vf), { 'example.com': 120, app: 55 }); n++; console.log('ok snapshot visitors totals only'); }
// ---- F20: one policy file, kill switch, quarantine, standing approvals, evidence gate with capped retries ----
const home = path.join(tmp, 'home'), kill = path.join(home, '.wk/KILL'); fs.mkdirSync(path.join(home, '.wk'), { recursive: true });
const POL = fs.readFileSync(path.resolve('config/gates.json'), 'utf8');
const plug = text => { const d = fs.mkdtempSync(path.join(tmp, 'plug-')); fs.mkdirSync(path.join(d, 'config')); fs.writeFileSync(path.join(d, 'config/gates.json'), typeof text === 'function' ? JSON.stringify(text(JSON.parse(POL))) : text); return d; };
const G = (tool_name, tool_input = {}, env = {}, extra = {}) => run('wk-guard.mjs', { tool_name, tool_input, ...extra }, [], env);
const W = { file_path: '/x/proj/a.js', content: 'hi' };
t('policy: missing, broken or incomplete gates.json fails closed', () => {
  for (const d of [plug('{ not json'), plug(p => { delete p.lane; return p; }), plug(p => { delete p.standing_approvals; return p; }), plug(p => { p.evidence.maxBlocks = 'x'; return p; })]) { const r = G('Read', { file_path: '/x/proj/a.js' }, { CLAUDE_PLUGIN_ROOT: d }); assert.equal(r.status, 2); assert.match(r.stderr, /failing closed/); }
  assert.equal(G('Read', { file_path: '/x/proj/a.js' }, { CLAUDE_PLUGIN_ROOT: path.join(tmp, 'nowhere') }).status, 2);
  assert.equal(run('wk-guard.mjs', { tool_input: { file_path: '/x/a.js' } }).status, 2); });
t('policy: project override cannot add approvals or move the kill switch; broken override fails closed', () => {
  const of = path.join(tmp, '.wk/gates.json');
  fs.writeFileSync(of, JSON.stringify({ standing_approvals: [{ id: 'x', gate: 'send-mail', description: 'd', bash: '.*', expires: '2099-01-01' }], kill_switch: { file: '/nonexistent', allowTools: ['Bash', 'Write'] }, gated: [] }));
  assert.match(G('Bash', { command: 'sendmail a@example.com' }).stderr, /gated/);
  fs.writeFileSync(kill, ''); assert.match(G('Write', W).stderr, /kill/); fs.rmSync(kill);
  fs.writeFileSync(of, '{ broken'); assert.equal(G('Read', { file_path: '/x/proj/a.js' }).status, 2); fs.rmSync(of); });
t('policy file is the owner\'s: edits and shell writes refused, reads allowed', () => {
  const pf = path.resolve('config/gates.json');
  assert.match(G('Edit', { file_path: pf, old_string: 'a', new_string: 'b' }).stderr, /policy/); assert.equal(G('Write', { file_path: pf, content: '{}' }).status, 2);
  assert.equal(G('Bash', { command: `sed -i '' s/2027/2099/ ${pf}` }).status, 2); assert.equal(G('Bash', { command: `echo x > config/gates.json` }).status, 2);
  assert.equal(G('Read', { file_path: pf }).status, 0); assert.equal(G('Bash', { command: `cat ${pf}` }).status, 0); });
t('kill switch: only read-only tools run while ~/.wk/KILL exists; fails closed on a stat error', () => {
  assert.equal(G('Write', W).status, 0); fs.writeFileSync(kill, '');
  for (const [tool, ti] of [['Read', { file_path: '/x/proj/a.js' }], ['Grep', { pattern: 'x', path: '/x/proj' }], ['Glob', { pattern: '*.js' }]]) assert.equal(G(tool, ti).status, 0, tool);
  for (const [tool, ti] of [['Write', W], ['Edit', { file_path: '/x/proj/a.js', old_string: 'a', new_string: 'b' }], ['Bash', { command: 'ls' }], ['WebFetch', { url: 'https://example.com' }], ['Agent', { prompt: 'x' }], ['mcp__claude_ai_Claude_Docs__batch', {}]]) { const r = G(tool, ti); assert.equal(r.status, 2, tool); assert.match(r.stderr, /kill switch/); }
  fs.rmSync(kill); assert.equal(G('Write', W).status, 0);
  fs.chmodSync(path.join(home, '.wk'), 0o000); try { assert.equal(G('Write', W).status, 2); assert.equal(G('Read', { file_path: '/x/proj/a.js' }).status, 0); } finally { fs.chmodSync(path.join(home, '.wk'), 0o755); } });
t('ask path (WK_ASK=1): Grep searches for keys, tokens or passwords are refused; other searches and other sessions are not', () => {
  for (const ti of [{ pattern: 'sk_live' }, { pattern: 'API_KEY', glob: '*.js' }, { pattern: 'password' }, { pattern: 'x', glob: '**/.env*' }]) assert.equal(G('Grep', ti, { WK_ASK: '1' }).status, 2, JSON.stringify(ti));
  assert.equal(G('Grep', { pattern: 'useState' }, { WK_ASK: '1' }).status, 0);
  assert.equal(G('Grep', { pattern: 'sk_live' }).status, 0, 'a normal session may scan for leaked keys'); });
t('quarantine: WK_QUARANTINE denies every tool, even with a broken policy', () => {
  const tools = [['Read', { file_path: '/x/proj/a.js' }], ['Grep', { pattern: 'x' }], ['Glob', { pattern: '*' }], ['LS', { path: '/x' }], ['Bash', { command: 'echo hi' }], ['Write', W], ['Edit', W], ['NotebookEdit', W], ['WebFetch', { url: 'https://example.com' }], ['WebSearch', { query: 'x' }], ['Agent', { prompt: 'x' }], ['Task', { prompt: 'x' }], ['Skill', { skill: 'x' }], ['TodoWrite', { todos: [] }], ['mcp__stripe__create_price', {}], ['SomeFutureTool', {}]];
  for (const v of ['1', 'yes', 'true']) for (const [tool, ti] of tools) { const r = G(tool, ti, { WK_QUARANTINE: v }); assert.equal(r.status, 2, tool + v); assert.match(r.stderr, /quarantine/); }
  assert.equal(G('Read', { file_path: '/x/proj/a.js' }, { WK_QUARANTINE: '1', CLAUDE_PLUGIN_ROOT: plug('{') }).stderr.includes('quarantine'), true);
  assert.equal(G('Read', { file_path: '/x/proj/a.js' }, { WK_QUARANTINE: '0' }).status, 0); });
t('quarantine: the quarantine subagent gets no tools; other agents keep theirs; profile has none', () => {
  for (const at of ['quarantine', 'watchkeeper:quarantine']) for (const tool of ['Read', 'Bash', 'WebFetch']) assert.equal(G(tool, tool === 'Bash' ? { command: 'ls' } : { file_path: '/x/proj/a.js', url: 'https://example.com' }, {}, { agent_id: 'a1', agent_type: at }).status, 2, at + tool);
  assert.equal(G('Read', { file_path: '/x/proj/a.js' }, {}, { agent_id: 'a2', agent_type: 'watchkeeper:scout' }).status, 0);
  const f = fs.readFileSync(path.resolve('agents/quarantine.md'), 'utf8'); assert.ok(!/^tools:/m.test(f)); for (const k of ['model:', 'maxTurns:', 'disallowedTools:', 'data']) assert.ok(f.includes(k), k); });
t('standing approvals: narrow, expiring, revocable by deleting the line', () => {
  // its own policy fixture: the shipped policy has no standing approvals
  const CAT = { id: 'catalogue', gate: 'money', description: 'create Stripe prices, products and payment links through a connector', tool: '^mcp__.*[Ss]tripe.*__create_(price|product|payment_link)s?$', expires: '2099-12-31' };
  const pol = JSON.parse(POL); pol.standing_approvals = ['@@'];
  const text = JSON.stringify(pol, null, 1).replace('"@@"', JSON.stringify(CAT) + ',\n' + JSON.stringify({ _end: 'keep this line' })), A = { CLAUDE_PLUGIN_ROOT: plug(text) };
  let r = G('mcp__stripe__create_price', { unit_amount: 1500 }, A); assert.equal(r.status, 0, r.stderr); assert.match(fs.readFileSync(path.join(tmp, '.wk/approved.log'), 'utf8'), /catalogue money/);
  for (const tool of ['mcp__stripe__create_refund', 'mcp__stripe__cancel_subscription', 'mcp__stripe__update_price']) assert.match(G(tool, {}, A).stderr, /gated/, tool);
  assert.equal(G('Bash', { command: 'sendmail -t < /tmp/m.eml' }, A).status, 2); assert.equal(G('Bash', { command: 'npm publish' }, A).status, 2); assert.equal(G('Bash', { command: 'grep mail notes.txt' }, A).status, 0);
  const lines = text.split('\n'); const cut = lines.filter(l => !l.includes('"id":"catalogue"')); assert.equal(cut.length, lines.length - 1);
  const revoked = plug(cut.join('\n')); assert.equal(G('Read', { file_path: '/x/proj/a.js' }, { CLAUDE_PLUGIN_ROOT: revoked }).status, 0); assert.equal(G('mcp__stripe__create_price', {}, { CLAUDE_PLUGIN_ROOT: revoked }).status, 2);
  const ap = (a) => plug(p => { p.standing_approvals = [a]; return p; }), base = { id: 'digest', gate: 'send-mail', description: 'weekly digest to the owner', bash: '^sendmail -t < /tmp/digest\\.eml$', expires: '2099-12-31' };
  assert.equal(G('Bash', { command: 'sendmail -t < /tmp/digest.eml' }, { CLAUDE_PLUGIN_ROOT: ap(base) }).status, 0);
  assert.equal(G('Bash', { command: 'sendmail -t < /tmp/other.eml' }, { CLAUDE_PLUGIN_ROOT: ap(base) }).status, 2);
  for (const bad of [{ ...base, expires: '2020-01-01' }, { ...base, expires: 'soon' }, { ...base, description: undefined }, { ...base, bash: undefined }, { ...base, bash: '(' }, { ...base, gate: 'publish' }]) assert.equal(G('Bash', { command: 'sendmail -t < /tmp/digest.eml' }, { CLAUDE_PLUGIN_ROOT: ap(bad) }).status, 2, JSON.stringify(bad));
  assert.equal(G('Bash', { command: 'git reset --hard' }, { CLAUDE_PLUGIN_ROOT: ap({ ...base, bash: '.*' }) }).status, 2); });
const EV = path.join(tmp, '.wk/evidence'), rec = (sid, command, stdout, extra = {}) => run('wk-evidence.mjs', { session_id: sid, tool_input: { command }, tool_response: { stdout, stderr: '', ...extra } }, ['record']);
const gateS = (sid, active = false, env = {}) => run('wk-evidence.mjs', { transcript_path: tr, session_id: sid, stop_hook_active: active }, ['gate'], env).stdout;
t('planted false done: no session evidence file is blocked', () => { say('Done: all tests pass.'); assert.match(gateS('f20-none'), /no session evidence file/); });
t('planted false done: a session file with no test line is blocked', () => { fs.writeFileSync(path.join(EV, 'f20-empty.jsonl'), '\n{"note":"hand-written"}\n'); say('Done, verified.'); assert.match(gateS('f20-empty'), /no test line/); });
t('stale test line is blocked; another session\'s pass does not count', () => { fs.writeFileSync(path.join(EV, 'f20-old.jsonl'), JSON.stringify({ at: Date.now() - 200 * 60000, command: 'npm test', exit: 0 }) + '\n'); say('Done.'); assert.match(gateS('f20-old'), /older/); rec('f20-other', 'npm test', 'WK_EXIT=0'); assert.match(gateS('f20-mine'), /block/); assert.equal(gateS('f20-other'), ''); });
t('planted regression: a failed run (exit 1) blocks done until that command passes again', () => {
  rec('f20-reg', 'npm test', 'WK_EXIT=0 WK_LOG=a'); say('Fixed, tests pass.'); assert.equal(gateS('f20-reg'), '');
  rec('f20-reg', 'pytest -q', '', { is_error: true }); let o = gateS('f20-reg'); assert.match(o, /block/); assert.match(o, /pytest -q/);
  rec('f20-reg', 'wk-run npm test', 'WK_EXIT=0'); assert.match(gateS('f20-reg'), /pytest -q/);          // a different passing test does not hide it
  rec('f20-reg', 'npm test', 'WK_EXIT=1'); assert.match(gateS('f20-reg'), /npm test/);
  rec('f20-reg', 'pytest -q', '12 passed, 0 failed'); rec('f20-reg', 'wk-run npm test', 'WK_EXIT=0'); assert.equal(gateS('f20-reg'), ''); });
t('evidence store is closed to tools (no forged test lines)', () => { assert.equal(G('Write', { file_path: path.join(EV, 'x.jsonl'), content: '{}' }).status, 2); assert.equal(G('Bash', { command: `echo '{"exit":0}' >> .wk/evidence/x.jsonl` }).status, 2); });
t('retry cap: stop_hook_active honoured, nudges capped per turn, defect counted, fresh stop resets', () => {
  say('Done.'); assert.match(gateS('f20-cap1'), /block/); assert.equal(gateS('f20-cap1', true), ''); assert.equal(gateS('f20-cap1', true), '');   // shipped cap: 1
  const two = plug(p => { p.evidence.maxBlocks = 2; return p; }), gs = a => gateS('f20-cap2', a, { CLAUDE_PLUGIN_ROOT: two });
  assert.match(gs(false), /block/); assert.match(gs(true), /block/); assert.equal(gs(true), ''); assert.equal(gs(true), ''); assert.match(gs(false), /block/);
  const d = fs.readFileSync(path.join(tmp, '.wk/defects.log'), 'utf8'); assert.match(d, /f20-cap1 unverified-done/); assert.match(d, /f20-cap2 unverified-done/);
  const broken = plug('{'); assert.match(gateS('f20-pol', false, { CLAUDE_PLUGIN_ROOT: broken }), /policy cannot be read/); assert.equal(gateS('f20-pol', true, { CLAUDE_PLUGIN_ROOT: broken }), ''); });
t('hooks: the guard runs on every tool', () => { const h = JSON.parse(fs.readFileSync(path.resolve('hooks/hooks.json'), 'utf8')); assert.equal(h.hooks.PreToolUse[0].matcher, '*'); });
// ---- security review, finding 1: the shell guard for the policy files fails closed on globs, quotes, variables and interpreters ----
const REPO = path.resolve('.'), pinF = path.join(home, '.wk/policy.sha256');
const refused = (cmd, extra = {}, env = {}) => { const r = G('Bash', { command: cmd }, env, extra); assert.equal(r.status, 2, `not refused: ${cmd}\n${r.stderr}`); return r.stderr; };
const passes = (cmd, extra = {}, env = {}) => { const r = G('Bash', { command: cmd }, env, extra); assert.equal(r.status, 0, `refused: ${cmd}\n${r.stderr}`); };
t('finding 1: glob spellings of gates.json are refused', () => { for (const c of ['echo x > config/g*tes.json', 'cp /tmp/x config/g[a]tes.json', 'cp /tmp/x config/g?tes.js*', 'tee config/*ates.json < /tmp/x']) assert.match(refused(c), /policy/, c); });
t('finding 1: quote and backslash splits of gates.json are refused', () => { for (const c of [`echo x > config/gat''es.json`, 'echo x > config/gat""es.json', 'echo x > config/gat\\es.json', `printf x > "config/"'gates'.json`]) refused(c); });
t('finding 1: variables building the name are refused', () => { for (const c of ['f=gat; f+=es.json; echo x > config/$f', 'D=config; N=gat; echo x > $D/${N}es.json']) refused(c, { cwd: REPO }); for (const c of ['x=gate; echo x > config/${x}s.json', 'echo x > "$(printf conf)ig/$(printf gate)s.json"', `D=${REPO}/config; echo x > $D/g*`]) refused(c); });
t('finding 1: cd into the config folder, then a glob, is refused', () => { for (const c of ['cd config && cp /tmp/x ./g*', 'cd config; cp /tmp/x g*', `cd ${REPO}/config && mv /tmp/x *.json`, 'pushd config >/dev/null; cp /tmp/x ./*']) refused(c, { cwd: REPO }); refused('cp /tmp/x ./*', { cwd: path.join(REPO, 'config') }); refused(`cd ${REPO} && f=gat; echo x > config/$f`); refused(`cd ${path.relative(tmp, REPO)}/config; cp /tmp/x $F`); refused('cd $P && echo x > config/$F'); });
t('finding 1: a python heredoc that concatenates the name is refused', () => {
  refused("python3 - <<'EOF'\nopen('con'+'fig/ga'+'tes.json','w').write('{}')\nEOF");
  refused("python3 - <<'EOF'\nimport os\np = os.path.join('config', 'ga' 'tes.json')\nopen(p, 'w').write('{}')\nEOF");
  refused(`node -e "require('fs').writeFileSync('con'+'fig/ga'+'tes.json','{}')"`); refused(`bash -c 'echo x > config/gat""es.json'`); refused("sh <<'EOF'\necho x > config/g*\nEOF"); });
t('finding 1: find -exec on the config folder is refused', () => { refused("find config -name 'g*' -exec cp /tmp/x {} \;"); refused('find . -path "*config*" -name "g*" -exec cp /tmp/x {} +'); refused("find . -name 'gat*' | xargs -I{} cp /tmp/x {}"); });
t('finding 1: the pin, the kill file and .wk are protected from tools and the shell', () => {
  for (const f of [pinF, kill]) { assert.match(G('Write', { file_path: f, content: 'x' }).stderr, /policy/, f); assert.equal(G('Edit', { file_path: f, old_string: 'a', new_string: 'b' }).status, 2, f); }
  for (const c of ['echo 0 > ~/.wk/policy.sha256', 'cp /tmp/p $HOME/.wk/policy.sha256', 'rm ~/.wk/KILL', 'rm -f "$HOME"/.wk/K*', 'mv ~/.wk /tmp/old', 'node bin/wk-pin.mjs', `node ${REPO}/bin/wk-pin.mjs`, 'rm -rf .wk/evidence', 'cat > .wk/gates.json <<EOF\n{}\nEOF', 'rm .wk/g*']) refused(c); });
t('finding 1: no false positives on plain reads and unrelated words', () => {
  for (const c of ['cat config/gates.json', 'head -5 config/gates.json', 'shasum -a 256 config/gates.json', 'grep -n gate bin/lib.mjs', 'diff config/gates.json /tmp/old.json', 'ls *.json', 'ls config', 'node bin/wk-pin.mjs --check', 'git diff config/gates.json', 'git commit -m "navigate the aggregate; delegate"', 'echo hello > out.txt', 'npm test', 'cp a.txt b.txt', 'ls .wk/blocked.log']) passes(c, { cwd: REPO }); });
t('policy words: gateway and gatekeeper folders run; gates.json in node -e, a heredoc or a gate_ spelling is still refused', () => {
  for (const c of ['cd ~/code/gateway-api && npm test', 'node gateway/server.js', 'cd ~/code/gatekeeper && node index.js']) passes(c);
  for (const c of [`node -e "console.log(require('fs').readFileSync('gates.json','utf8'))"`, "python3 - <<'EOF'\nprint(open('gates.json').read())\nEOF", `node -e "const f='gate_'.replace('_','s.json'); require('fs').writeFileSync(f,'{}')"`]) assert.match(refused(c), /policy|gate/, c);
  assert.match(refused(`node -e "1" # gates`), /change the policy by hand yourself/); });
t('guard input without a cwd: the rules still apply (gated classes, policy commands)', () => {
  const neutral = plug(p => { p.standing_approvals = p.standing_approvals.filter(a => a._end); return p; }), env = { CLAUDE_PLUGIN_ROOT: neutral };
  for (const [tool, ti] of [['mcp__stripe__create_price', { unit_amount: 1500 }], ['Bash', { command: 'npm publish' }]]) { const r = G(tool, ti, env); assert.equal(r.status, 2, tool); assert.match(r.stderr, /gated/, tool); }
  const r = spawnSync('node', [path.join(B, 'wk-guard.mjs')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cp /tmp/x ./*' } }), encoding: 'utf8', cwd: path.join(REPO, 'config'), env: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDE_PLUGIN_ROOT: REPO, HOME: home, WK_HOME: path.join(home, '.wk'), WK_POLICY_SHA256: '' } });   // no cwd in the input: the process folder (the config folder) counts
  assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /policy/); });
// ---- finding 2: gated classes match the normalised command, so wrappers, paths, quotes and sh -c do not get round them ----
const gated = c => { const r = G('Bash', { command: c }); assert.equal(r.status, 2, `not gated: ${c}`); assert.match(r.stderr, /gated/, c); };
t('finding 2: send-mail behind paths, wrappers, quotes, backslashes and sh -c is gated', () => {
  for (const c of ['/usr/sbin/sendmail -t < /tmp/m.eml', '"/usr/sbin/sendmail" -t', 'env FOO=1 sendmail a@example.com', 'env -i PATH=/usr/bin sendmail x', 'command sendmail x', 'sudo -u root sendmail x', 'doas sendmail x', 'echo x | xargs sendmail', 'echo x | xargs -n 1 /usr/sbin/sendmail', 'nohup sendmail x &', 'exec sendmail x', 'time sendmail x', 'timeout 5 sendmail x', 'nice -n 5 sendmail x', 'stdbuf -oL sendmail x', 'builtin sendmail x', 'bash -c "sendmail x"', "sh -c 'mailx -s hi a@example.com'", 'bash -lc "sendmail x"', "'sendmail' x", 's\\endmail x', "send''mail x", 'SENDMAIL x', '(sendmail x)', 'true && sendmail x', '$(which sendmail) x', "find . -name m.eml -exec sendmail -t {} \;", 'if true; then msmtp x; fi']) gated(c); });
t('finding 2: publish variants are gated, including npm run publish', () => { for (const c of ['npm publish', 'npm --silent publish', 'npm run publish', 'pnpm -r publish', 'yarn npm publish', 'env CI=1 npm publish --access public', '/usr/local/bin/npm publish', 'python3 -m twine upload dist/x.whl', 'twine upload dist/x.whl', 'gh release create v1.0', 'gh -R a/b release create v1']) gated(c); });
t('finding 2: Stripe money URLs match the host anywhere; the stripe CLI money commands are gated', () => {
  for (const c of ['curl https://API.STRIPE.COM//v1/charges -d amount=100', 'curl https://api.stripe.com:443/v1/refunds -d charge=x', 'curl -X POST "https://api.stripe.com/v1/payment_intents" -d amount=1', "curl 'https://api.stripe.com/v1/payouts'", 'wget --post-data=x https://api.stripe.com/v1/transfers', 'stripe charges create --amount 500', 'stripe refunds create --charge ch_1', 'stripe payouts create --amount 1', 'stripe transfers create --amount 1', 'stripe payment_intents create --amount 1', 'stripe payment_intents confirm pi_1', 'stripe post /v1/charges', 'sudo stripe refunds create --charge ch_1']) gated(c); });
t('finding 2: no false positives on mail, publish and stripe words', () => { for (const c of ['ls mailbox', 'echo mail', 'grep -r sendmail docs', 'man sendmail', 'cat mail.txt', 'npm test', 'npm run build', 'gh release view v1', 'stripe charges list', 'curl https://example.com/charges', 'echo publish']) passes(c); });
// ---- integrity pin ----
const plugPinned = () => plug(p => { p.denyBash = []; return p; });   // a policy changed after the pin (as by an un-spotted script)
t('pin: a matching file pin passes; a changed policy then allows only read-only tools', () => {
  fs.writeFileSync(pinF, PIN + '\n');
  try {
    assert.equal(G('Write', W).status, 0); assert.equal(G('Bash', { command: 'ls' }).status, 0);
    const d = plugPinned();
    for (const [tool, ti] of [['Write', W], ['Edit', { file_path: '/x/proj/a.js', old_string: 'a', new_string: 'b' }], ['Bash', { command: 'ls' }], ['WebFetch', { url: 'https://example.com' }], ['mcp__stripe__create_price', {}]]) { const r = G(tool, ti, { CLAUDE_PLUGIN_ROOT: d }); assert.equal(r.status, 2, tool); assert.match(r.stderr, /policy changed since it was pinned/); }
    for (const [tool, ti] of [['Read', { file_path: '/x/proj/a.js' }], ['Grep', { pattern: 'x', path: '/x/proj' }], ['Glob', { pattern: '*.js' }]]) assert.equal(G(tool, ti, { CLAUDE_PLUGIN_ROOT: d }).status, 0, tool);
  } finally { fs.rmSync(pinF, { force: true }); } });
t('pin: the env pin beats the file pin', () => {
  fs.writeFileSync(pinF, '0'.repeat(64) + '\n');
  try { assert.equal(G('Write', W).status, 2); assert.equal(G('Write', W, { WK_POLICY_SHA256: PIN }).status, 0); fs.writeFileSync(pinF, PIN + '\n'); assert.equal(G('Write', W).status, 0); assert.equal(G('Write', W, { WK_POLICY_SHA256: 'f'.repeat(64) }).status, 2); }
  finally { fs.rmSync(pinF, { force: true }); } });
t('pin: lane mode without any pin denies every tool; no pin outside the lane keeps today\'s behaviour', () => {
  for (const [tool, ti] of [['Read', { file_path: path.join(snap, 'x.json') }], ['Bash', { command: `ls ${snap}` }]]) { const r = G(tool, ti, { WK_LANE: '1', WK_LANE_ROOTS: snap }); assert.equal(r.status, 2, tool); assert.match(r.stderr, /lane mode needs a pinned policy/); }
  assert.equal(G('Read', { file_path: path.join(snap, 'x.json') }, { WK_LANE: '1', WK_LANE_ROOTS: snap, WK_POLICY_SHA256: PIN }).status, 0);
  assert.equal(G('Write', W).status, 0); });
t('wk-pin: pins, checks, refuses an invalid policy; start hook names a missing pin', () => {
  const h2 = fs.mkdtempSync(path.join(tmp, 'h2-')), P = (args, env = {}) => run('wk-pin.mjs', {}, args, { HOME: h2, ...env });
  let r = P(['--check']); assert.equal(r.status, 1); assert.match(r.stdout, /not pinned/);
  assert.match(run('wk-start.mjs', {}, [], { HOME: h2 }).stdout, /policy not pinned/);
  r = P([]); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), PIN); assert.equal(fs.readFileSync(path.join(h2, '.wk/policy.sha256'), 'utf8').trim(), PIN);
  assert.equal(P(['--check']).status, 0); assert.ok(!run('wk-start.mjs', {}, [], { HOME: h2 }).stdout.includes('not pinned'));
  r = P(['--check'], { CLAUDE_PLUGIN_ROOT: plugPinned() }); assert.equal(r.status, 1); assert.match(r.stdout, /MISMATCH/);
  const h3 = fs.mkdtempSync(path.join(tmp, 'h3-')); assert.equal(run('wk-pin.mjs', {}, [], { HOME: h3, CLAUDE_PLUGIN_ROOT: plug('{') }).status, 2); assert.ok(!fs.existsSync(path.join(h3, '.wk/policy.sha256'))); });
t('wk-lane: exports the pin computed at launch; a stale pin stops the launch', () => {
  const h4 = fs.mkdtempSync(path.join(tmp, 'h4-')), env = { ...process.env, HOME: h4, WK_POLICY_SHA256: '' };
  let r = spawnSync('node', [path.join(B, 'wk-lane'), '--check-env'], { encoding: 'utf8', env }); assert.ok(JSON.parse(r.stdout).includes('WK_POLICY_SHA256'));
  const pf = path.join(tmp, 'p2.txt'); fs.writeFileSync(pf, 'Summarise totals.'); const envSh = path.join(tmp, 'printenv.sh'); fs.writeFileSync(envSh, '#!/bin/sh\nenv\n', { mode: 0o755 });
  r = spawnSync('node', [path.join(B, 'wk-lane'), '--roots', snap, '--', pf], { encoding: 'utf8', env: { ...env, WK_CLAUDE: envSh } }); assert.equal(r.status, 0); assert.ok(r.stdout.includes(`WK_POLICY_SHA256=${PIN}`));
  r = spawnSync('node', [path.join(B, 'wk-lane'), '--roots', snap, '--', pf], { encoding: 'utf8', env: { ...env, WK_CLAUDE: envSh, WK_POLICY_SHA256: '0'.repeat(64) } }); assert.equal(r.status, 2); assert.match(r.stderr, /policy changed/); });
t('steward suites pass (node --test, one file at a time, temp worlds and the fake claude)', () => {
  const files = fs.readdirSync('test').filter(f => /^(steward|ledger)\.[\w-]+\.test\.mjs$/.test(f)).sort().map(f => path.join('test', f));
  assert.ok(files.length >= 2, 'the steward test files are missing');
  const env = { ...process.env }; for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(k) || k === 'WK_LANE' || k === 'CLAUDE_PLUGIN_ROOT') delete env[k];
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { encoding: 'utf8', env, timeout: 600000 });
  const counts = (r.stdout.match(/^ℹ (tests|pass|fail) \d+$/gm) || []).join(', ');
  assert.equal(r.status, 0, `node --test failed (${counts}):\n${r.stdout.slice(-3000)}${(r.stderr || '').slice(-1000)}`);
  console.log('   ', counts, 'in', files.length, 'files');
});
console.log(`${n} passed`);
