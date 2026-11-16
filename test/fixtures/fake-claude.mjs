#!/usr/bin/env node
// A stand-in for the `claude` command, used only by the steward tests (WK_CLAUDE=<this file>).
// It speaks the same stream-json shape as the real CLI 2.1.310 (checked on 8 Nov 2026 with a real Haiku call):
//   system/init, [rate_limit_event], assistant, result.
// It never touches the network. Every call is appended to FAKE_LOG as one JSON line (never the value of any key).
//
// Which answer a call gives (calls with --json-schema; the meter probe has none and always answers "ok" unless FAKE_PROBE_MODE says otherwise):
//   FAKE_MODE      one mode for every call            FAKE_SCRIPT   a JSON array of modes, one per call (the last one repeats)
// Modes: ok | limit | invalid | error | hang | noise | exit1 | partial
// Other knobs (all optional):
//   FAKE_LOG, FAKE_COUNTER (default FAKE_LOG + ".n"), FAKE_APIKEYSOURCE (default "ANTHROPIC_API_KEY" when that variable is set, else "none"),
//   FAKE_INIT_SLEEP_MS (wait after init), FAKE_DELAY_MS (wait before the result), FAKE_COST (default 0.012; the probe 0.0006),
//   FAKE_UTIL or FAKE_UTIL_FILE (weekly utilisation 0..1; no value means no rate_limit_event), FAKE_FIVE_UTIL, FAKE_RESET (epoch seconds, default 1794189600),
//   FAKE_LIMIT_RESET (epoch seconds for the limit mode), FAKE_IDEAS_FILE (a literal structured_output), FAKE_KINDS, FAKE_IMPACT, FAKE_GATE, FAKE_EFFORT,
//   FAKE_EXTRA (extra ideas beyond what was asked), FAKE_COUNT (exact number of ideas), FAKE_K_BASE (fixes the title series: the same titles again), FAKE_QA=1.
import fs from 'node:fs';

const argv = process.argv.slice(2), val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const env = process.env, prompt = val('-p') ?? '', modelArg = val('--model') ?? 'sonnet', schemaText = val('--json-schema'), system = val('--system-prompt') ?? '', isProbe = !schemaText;
const write = o => new Promise(r => process.stdout.write(JSON.stringify(o) + '\n', () => r()));
const raw = text => new Promise(r => process.stdout.write(text, () => r()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readNum = f => { try { return Number(fs.readFileSync(f, 'utf8').trim()); } catch { return NaN; } };

// how many schema calls came before this one
const counterFile = env.FAKE_COUNTER || (env.FAKE_LOG ? env.FAKE_LOG + '.n' : null);
let n = 0; if (counterFile && !isProbe) { n = readNum(counterFile); n = Number.isFinite(n) ? n : 0; fs.writeFileSync(counterFile, String(n + 1)); }

let mode = isProbe ? (env.FAKE_PROBE_MODE || 'ok') : (env.FAKE_MODE || 'ok');
if (!isProbe && env.FAKE_SCRIPT) { try { const a = JSON.parse(fs.readFileSync(env.FAKE_SCRIPT, 'utf8')); if (Array.isArray(a) && a.length) mode = String(a[Math.min(n, a.length - 1)]); } catch {} }

const apiKeySource = env.FAKE_APIKEYSOURCE ?? (env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none');
if (env.FAKE_LOG) {
  const has = k => Object.hasOwn(env, k);
  fs.appendFileSync(env.FAKE_LOG, JSON.stringify({ pid: process.pid, mode, probe: isProbe, n, model: modelArg, cap: val('--max-budget-usd'), effort: val('--effort'), tools: val('--tools'), settingSources: val('--setting-sources'),
    hasSchema: !isProbe, hasSystem: system.length > 0, systemHasPlaceholder: /\{\{/.test(system), promptChars: prompt.length, strictMcp: argv.includes('--strict-mcp-config'), noSession: argv.includes('--no-session-persistence'), noSlash: argv.includes('--disable-slash-commands'),
    stream: val('--output-format'), verbose: argv.includes('--verbose'), apiKeySource,
    env: { key: has('ANTHROPIC_API_KEY'), token: has('ANTHROPIC_AUTH_TOKEN'), baseUrl: has('ANTHROPIC_BASE_URL'), bedrock: has('CLAUDE_CODE_USE_BEDROCK'), vertex: has('CLAUDE_CODE_USE_VERTEX'), noMds: env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, noMem: env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, stewardCall: env.WK_STEWARD_CALL, noTitle: env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE, noCache: env.DISABLE_PROMPT_CACHING },
    cwd: fs.realpathSync(process.cwd()), prompt: env.FAKE_LOG_PROMPT ? prompt : undefined }) + '\n');
}

// ------------------------------------------------------------ four disjoint word lists: two different titles share at most two of the four slot words,
// so their Jaccard similarity is at most 4/8 = 0.5 (the steward's duplicate limit is 0.7), for k below 13*17*19 = 4199
const VERB = ['add', 'write', 'draft', 'map', 'test', 'trim', 'check', 'build', 'sort', 'fix', 'plan', 'merge', 'review'];
const ADJ = ['quick', 'small', 'clear', 'simple', 'short', 'friendly', 'warm', 'bright', 'steady', 'gentle', 'plain', 'fresh', 'calm', 'bold', 'light', 'smooth', 'neat'];
const NOUN = ['intro', 'checklist', 'guide', 'diagram', 'summary', 'outline', 'glossary', 'template', 'layout', 'tutorial', 'footer', 'banner', 'sidebar', 'handbook', 'cheatsheet', 'gallery', 'timeline', 'tooltip', 'breadcrumb'];
const TOPIC = ['onboarding', 'navigation', 'accessibility', 'search', 'homepage', 'signup', 'settings', 'profile', 'feedback', 'errors', 'loading', 'mobile', 'contacts', 'dashboards', 'uploads', 'reminders', 'shortcuts', 'languages', 'themes', 'offline', 'notifications', 'bookmarks', 'filters'];
const cap = s => s[0].toUpperCase() + s.slice(1);
const titleOf = k => `${cap(VERB[k % 13])} the ${ADJ[(3 * k + 1) % 17]} ${NOUN[(5 * k + 2) % 19]} for ${TOPIC[(7 * k + 3) % 23]}`;

function ideas() {
  if (env.FAKE_IDEAS_FILE) return JSON.parse(fs.readFileSync(env.FAKE_IDEAS_FILE, 'utf8'));
  const m = /WANT: (\d+) ideas, impact (\d+)/.exec(prompt), want = m ? +m[1] : 3, minImpact = m ? +m[2] : 2;
  const project = (/PROJECT: (.+?) \(/.exec(prompt) || [])[1] || 'the project', count = env.FAKE_COUNT ? +env.FAKE_COUNT : want + (+env.FAKE_EXTRA || 0);
  const kinds = (env.FAKE_KINDS || 'code,design,content,research,admin').split(','), base = env.FAKE_K_BASE !== undefined ? +env.FAKE_K_BASE : n;
  const impact = env.FAKE_IMPACT ? +env.FAKE_IMPACT : Math.max(3, minImpact), out = [];
  for (let i = 0; i < count; i++) {
    const k = base * 8 + i;
    out.push({ title: titleOf(k), why: `The brief for ${project} shows room here, so one small step helps.`, kind: kinds[i % kinds.length], impact, effort: 1 + (k % 5), gate: env.FAKE_GATE || 'auto' });
  }
  const o = { ideas: out };
  if (env.FAKE_QA === '1') o.qa = [{ q: 'Who is the first reader of this project?', a: 'A beginner who wants one plain first step.' }];
  return o;
}

const usage = { input_tokens: 2, cache_creation_input_tokens: 1500, cache_read_input_tokens: 0, output_tokens: 300 };
const modelId = /haiku/i.test(modelArg) ? 'claude-haiku-5-5' : /opus/i.test(modelArg) ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
const cost = isProbe ? 0.0006 : (env.FAKE_COST !== undefined ? +env.FAKE_COST : 0.012);
const sessionId = '00000000-0000-4000-8000-000000000001';
const result = extra => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 900, duration_api_ms: 800, num_turns: 2, api_error_status: null, terminal_reason: 'completed', total_cost_usd: cost, usage, modelUsage: { [modelId]: { inputTokens: 2, outputTokens: 300, cacheReadInputTokens: 0, cacheCreationInputTokens: 1500, costUSD: cost } }, session_id: sessionId, uuid: sessionId, ...extra });
const rateEvent = (status, util, reset) => {
  const w = { utilization: util, resetsAt: reset, status }, unified = { seven_day: w };
  if (env.FAKE_FIVE_UTIL !== undefined) unified.five_hour = { utilization: +env.FAKE_FIVE_UTIL, resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600, status: 'allowed' };
  return { type: 'rate_limit_event', rate_limit_info: { status, resetsAt: reset, rateLimitType: 'seven_day', utilization: util, overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false, unifiedWindows: unified, overageEnabled: false }, uuid: sessionId, session_id: sessionId };
};
const utilNow = () => { const u = env.FAKE_UTIL_FILE ? readNum(env.FAKE_UTIL_FILE) : (env.FAKE_UTIL !== undefined ? Number(env.FAKE_UTIL) : NaN); return Number.isFinite(u) ? u : null; };

async function main() {
  await write({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, tools: isProbe ? [] : ['StructuredOutput'], mcp_servers: [], model: modelId, permissionMode: 'default', apiKeySource, claude_code_version: '2.1.310', uuid: sessionId });
  if (env.FAKE_INIT_SLEEP_MS) await sleep(+env.FAKE_INIT_SLEEP_MS);
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'exit1') { process.stderr.write('fatal: the fake claude was told to fail\n'); process.exit(1); }
  const util = utilNow(), reset = env.FAKE_RESET ? +env.FAKE_RESET : 1794189600;
  if (mode === 'noise') { await raw('this line is not json\n'); await write({ type: 'some_future_event', payload: { a: 1 } }); await raw('{"broken": \n'); }
  if (mode === 'limit') {
    const lr = env.FAKE_LIMIT_RESET ? +env.FAKE_LIMIT_RESET : null;
    await write(rateEvent('rejected', util ?? 1, lr ?? reset));
    await write(result({ is_error: true, api_error_status: 429, result: "You've hit your usage limit.", terminal_reason: 'api_error', total_cost_usd: 0, modelUsage: {} }));
    process.exit(1);
  }
  if (util !== null) await write(rateEvent(util >= 0.75 ? 'allowed_warning' : 'allowed', util, reset));
  await write({ type: 'assistant', message: { role: 'assistant', model: modelId, content: [{ type: 'text', text: isProbe ? 'ok' : '(structured answer)' }], usage }, session_id: sessionId, uuid: sessionId });
  if (env.FAKE_DELAY_MS) await sleep(+env.FAKE_DELAY_MS);
  if (mode === 'error') { await write(result({ subtype: 'error_during_execution', is_error: true, result: 'The fake claude was told to fail.' })); process.exit(1); }
  if (mode === 'invalid') { await write(result({ result: 'I could not think of anything useful.' })); process.exit(0); }
  if (mode === 'partial') { await write(result({ result: '{"ideas":[{"title":"Cut the quick' })); process.exit(0); }
  if (isProbe) { await write(result({ result: 'ok' })); process.exit(0); }
  const so = ideas();
  await write(result({ result: JSON.stringify(so), structured_output: so }));
  process.exit(0);
}
main().catch(e => { process.stderr.write(String(e?.stack || e) + '\n'); process.exit(3); });
