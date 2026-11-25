#!/usr/bin/env node
// wk-ask (P2-278): the API drive. One agent asks the other model one question through the official API, with the
// user's own key: Claude Code hands a small, quick question that cannot wait to Gemini (big or long work goes in the
// queue with wk-task add, on the Antigravity plan); Antigravity hands hard reasoning or review to Claude. One-shot by design: the answer is text (an answer, a plan or a unified diff); the calling agent
// reviews and applies it. No tool loop, no child process, and the key never goes into argv, env, a log or the output.
//   wk-ask gemini|claude "<task>" [--file <path>]... [--model <alias|id>] [--max-out N] [--system "<text>"] [--json]
//   wk-ask gemini|claude - ...            the task comes on stdin
//   wk-ask gemini|claude --stdin-json     {task, files, model, max_out, system} on stdin (the MCP tools use this)
// Checks before any request, in this order: stop switch ~/.wk/KILL (exit 3); API drive switched off (4); daily cost cap
// or calls per hour (5); no key saved (6). Bad use or a refused file: 2. The request failed: 1.
// Env: WK_HOME, WK_KEYS_DIR, WK_GEMINI_API_HOST, WK_ANTHROPIC_API_HOST (local test hosts only), WK_CALLER.
import fs from 'node:fs';
import path from 'node:path';
import * as L from './api-drive-lib.mjs';
import { gates, glob2re, killFile } from './lib.mjs';

const DEFAULT_SYSTEM = 'Another AI agent sends you this one-shot task through Watchkeeper. Reply with text only: an answer, a plan or a unified diff. You cannot run tools.';
const MAX_TASK = 200 * 1024, MAX_FILES = 50, MAX_OUT_LIMIT = 64000;
const USAGE = 'Use: wk-ask gemini|claude "<task>" [--file <path>]... [--model <alias|id>] [--max-out N] [--system "<text>"] [--json]  (task "-" reads stdin; --stdin-json reads {task, files, model, max_out, system})';

let JSON_OUT = false, PROVIDER = null;
class Stop extends Error { constructor(code, msg) { super(msg); this.exit = code; } }
const stop = (code, msg) => { throw new Stop(code, msg); };

async function readStdin() { const c = []; for await (const x of process.stdin) c.push(x); return Buffer.concat(c).toString('utf8'); }

function parseArgs(argv) {
  const o = { files: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) stop(2, `${a} needs a value. ${USAGE}`); return argv[++i]; };
    if (a === '--json') o.json = true;
    else if (a === '--stdin-json') o.stdinJson = true;
    else if (a === '--file') o.files.push(next());
    else if (a === '--model') o.model = next();
    else if (a === '--max-out') o.maxOut = next();
    else if (a === '--system') o.system = next();
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--')) stop(2, `Unknown option ${a}. ${USAGE}`);
    else rest.push(a);
  }
  o.provider = rest.shift(); o.task = rest.length ? rest.join(' ') : undefined;
  return o;
}

// ---------------------------------------------------------------- files
// The project root: the nearest folder with .git (found without running git), else the cwd.
function projectRoot(cwd) {
  let d = path.resolve(cwd);
  for (;;) { if (fs.existsSync(path.join(d, '.git'))) return d; const up = path.dirname(d); if (up === d) return path.resolve(cwd); d = up; }
}
const under = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const realOr = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

function readFiles(list, cwd, cfg) {
  if (!list.length) return [];
  if (list.length > MAX_FILES) stop(2, `At most ${MAX_FILES} files per call.`);
  let deny;
  try { deny = gates({ allowMismatch: true }).denyPathGlobs.map(glob2re); } catch { stop(2, 'Watchkeeper could not load its policy (gates.json), so no file was sent.'); }
  const root = realOr(projectRoot(cwd)), cap = cfg.max_files_kb * 1024;
  // the review's M5: the keys folder is compared by device plus inode (and case-folded real path) with every folder above each file,
  // and a project root that is /, a home folder or a folder above the keys folder is refused outright
  const keyDirs = [L.keysDir(), ...L.defaultKeysDirs()];
  if (root === path.parse(root).root || L.homeDirs().some(h => L.sameFolder(root, h)))
    stop(2, `The project folder (${root}) is / or a home folder, so no file is sent from it; run wk-ask inside a project.`);
  if (keyDirs.some(k => L.isAtOrAbove(root, k)))
    stop(2, `The project folder (${root}) holds the API key folder, and the API key folder is never sent, so no file is sent from this project; keep the keys outside it.`);
  let total = 0; const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw || raw.includes('\0')) stop(2, 'A file name is empty or not text.');
    const given = path.resolve(cwd, raw.replace(/^~(?=\/|$)/, process.env.HOME || ''));
    let real; try { real = fs.realpathSync(given); } catch { stop(2, `${raw}: no such file.`); }
    if (keyDirs.some(k => L.isAtOrAbove(k, real) || L.isAtOrAbove(k, given))) stop(2, `${raw}: the API key folder is never sent.`);
    if (!under(real, root)) stop(2, `${raw}: only files inside the project (${root}) are sent; links that lead outside are refused.`);
    const rel = path.relative(root, real) || path.basename(real);
    if ([real, given, rel].some(p => deny.some(r => r.test(p)))) stop(2, `${raw}: excluded by gates.json, so it is never sent.`);
    const st = fs.statSync(real);
    if (!st.isFile()) stop(2, `${raw}: not a file.`);
    total += st.size; if (total > cap) stop(2, `The files come to more than ${cfg.max_files_kb} KB; send fewer or smaller files.`);
    const buf = fs.readFileSync(real);
    let text;
    try { if (buf.includes(0)) throw 0; text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { stop(2, `${raw}: not a text file.`); }
    out.push({ rel: rel.split(path.sep).join('/'), text });
  }
  return out;
}
const filesBlock = files => files.map(f => `=== file: ${f.rel} ===\n${f.text}${f.text.endsWith('\n') ? '' : '\n'}=== end of ${f.rel} ===\n`).join('\n');

// ---------------------------------------------------------------- requests (stable prefix first: system, files, task)
export function buildGemini({ system, files, task, maxOut }) {
  const parts = []; if (files) parts.push({ text: files }); parts.push({ text: task });
  return { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: maxOut } };
}
export function buildClaude({ model, system, files, task, maxOut, cacheMin }) {
  const content = [];
  if (files) {
    const block = { type: 'text', text: files };
    if (estTokens(system + files) >= cacheMin) block.cache_control = { type: 'ephemeral' };
    content.push(block);
  }
  content.push({ type: 'text', text: task });
  return { model, max_tokens: maxOut, system: [{ type: 'text', text: system }], messages: [{ role: 'user', content }] };
}
export function parseGemini(j) {
  const u = j.usageMetadata || {};
  const usage = { in: u.promptTokenCount | 0, cached: u.cachedContentTokenCount | 0, cache_write: 0, out: (u.candidatesTokenCount | 0) + (u.thoughtsTokenCount | 0) };
  const c = Array.isArray(j.candidates) ? j.candidates[0] : null;
  const answer = (c?.content?.parts || []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
  const why = j.promptFeedback?.blockReason || (!answer && c?.finishReason) || null;
  return { answer, usage, why };
}
export function parseClaude(j) {
  const u = j.usage || {};
  const write = u.cache_creation_input_tokens | 0, read = u.cache_read_input_tokens | 0;
  const usage = { in: (u.input_tokens | 0) + write + read, cached: read, cache_write: write, out: u.output_tokens | 0 };
  const answer = (Array.isArray(j.content) ? j.content : []).filter(b => b && b.type === 'text').map(b => b.text).join('');
  return { answer, usage, why: !answer ? (j.stop_reason || 'empty') : null };
}

// tokens, estimated on the safe side (the review's S3 and N4): UTF-8 bytes / 2, so text in Georgian, Chinese or code is not undercounted
export const estTokens = s => Math.ceil(Buffer.byteLength(String(s), 'utf8') / 2);
const money = n => (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2));

async function run(o) {
  const cfg = L.loadConfig();
  const p = PROVIDER = L.normProvider(o.provider);
  if (!p) stop(2, USAGE);
  if (o.stdinJson) {
    let j; try { j = JSON.parse(await readStdin()); } catch { stop(2, 'The request on stdin is not JSON.'); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) stop(2, 'The request on stdin must be a JSON object.');
    o.task = j.task; o.files = Array.isArray(j.files) ? j.files : (j.files == null ? [] : stop(2, '"files" must be a list.'));
    if (j.model != null) o.model = String(j.model); if (j.max_out != null) o.maxOut = j.max_out; if (j.system != null) o.system = String(j.system);
  } else if (o.task === '-') o.task = await readStdin();
  if (typeof o.task !== 'string' || !o.task.trim()) stop(2, `No task given. ${USAGE}`);
  if (Buffer.byteLength(o.task) > MAX_TASK) stop(2, 'The task is over 200 KB; put the bulk in files.');
  const model = L.resolveModel(p, o.model, cfg);
  if (!model) stop(2, `Unknown model "${String(o.model).slice(0, 80)}" for ${L.PROVIDERS[p].label}: use an alias (${Object.keys(cfg.aliases[p] || {}).join(', ')}) or a full ${p === 'gemini' ? 'gemini-' : 'claude-'} model id.`);
  const maxOut = o.maxOut == null ? cfg.max_out : Number(o.maxOut);
  if (!Number.isInteger(maxOut) || maxOut < 1 || maxOut > MAX_OUT_LIMIT) stop(2, `--max-out must be a whole number from 1 to ${MAX_OUT_LIMIT}.`);
  const system = typeof o.system === 'string' && o.system.trim() ? o.system : DEFAULT_SYSTEM;

  // the checks, in order; no network before all pass
  let kill = [path.join(L.wkHome(), 'KILL')];
  try { kill.push(killFile(gates({ allowMismatch: true }))); } catch {}
  if (kill.some(f => { try { fs.statSync(f); return true; } catch (e) { return !['ENOENT', 'ENOTDIR'].includes(e.code); } })) stop(3, 'The stop switch is on (~/.wk/KILL), so nothing was sent.');
  if (!cfg.enabled) stop(4, 'The API drive is switched off in ~/.wk/api-drive.json, so nothing was sent.');
  const cap = L.capFor(p, cfg), lines = L.readUsage(), today = L.todaySpend(p, new Date(), lines);
  if (today >= cap) stop(5, `Today's ${L.PROVIDERS[p].label} spend is US$${money(today)}, at the daily cap of US$${money(cap)}; nothing was sent. The cap resets at midnight UTC.`);
  if (L.callsLastHour(p, new Date(), lines) >= cfg.hourly_calls) stop(5, `${cfg.hourly_calls} ${L.PROVIDERS[p].label} calls in the last hour is the limit; nothing was sent. Try again later.`);
  const key = L.readKey(p);
  if (!key) stop(6, L.NO_KEY_MSG);

  const files = readFiles(o.files, process.cwd(), cfg);
  const fb = filesBlock(files);
  // the most this call can cost: the whole prompt uncached plus the full output; refused when it would pass the cap
  const estIn = estTokens(system + fb + o.task);
  const worst = L.costForCap(p, model, { in: estIn, out: maxOut, cache_write: p === 'claude' ? estIn : 0 }, L.utcDay(), cfg).cap_cost;
  const worstStop = spent => stop(5, `This call could cost up to US$${money(worst)}, which would pass today's ${L.PROVIDERS[p].label} cap (US$${money(spent)} of US$${money(cap)} spent); nothing was sent. Send less, lower --max-out or raise the cap in ~/.wk/api-drive.json.`);
  if (today + worst > cap) worstStop(today);

  let host; try { host = L.hostFor(p); } catch (e) { stop(2, e.message); }
  const caller = L.detectCaller();
  const req = p === 'gemini'
    ? { url: `${host}/v1beta/models/${encodeURIComponent(model)}:generateContent`, body: buildGemini({ system, files: fb, task: o.task, maxOut }) }
    : { url: `${host}/v1/messages`, body: buildClaude({ model, system, files: fb, task: o.task, maxOut, cacheMin: cfg.claude_cache_min_tokens }) };
  // last stop (the review's M5): anything in the outgoing body that looks like a key refuses the call
  const bodyText = JSON.stringify(req.body);
  if (L.redact(bodyText) !== bodyText) stop(2, 'The request carries something that looks like an API key, so nothing was sent.');
  // the review's M4: under one lock, the caps are checked again and a worst-case reservation is written before the request
  let rid;
  try {
    rid = L.reserveCall({ provider: p, model, caller, cap_cost: worst }, lines2 => {
      const spent = L.todaySpend(p, new Date(), lines2);
      if (spent >= cap) stop(5, `Today's ${L.PROVIDERS[p].label} spend is US$${money(spent)}, at the daily cap of US$${money(cap)}; nothing was sent. The cap resets at midnight UTC.`);
      if (L.callsLastHour(p, new Date(), lines2) >= cfg.hourly_calls) stop(5, `${cfg.hourly_calls} ${L.PROVIDERS[p].label} calls in the last hour is the limit; nothing was sent. Try again later.`);
      if (spent + worst > cap) worstStop(spent);
    });
  } catch (e) { if (e instanceof Stop) throw e; stop(1, e.message); }
  const t0 = Date.now();
  let res;
  try {
    res = await L.request({ method: 'POST', url: req.url, headers: { ...L.authHeaders(p, key), 'content-type': 'application/json' }, body: req.body, timeoutMs: cfg.timeout_s * 1000 });
  } catch (e) {
    L.appendUsage({ provider: p, model, caller, ms: Date.now() - t0, ok: false, cost: 0, cap_cost: 0, status: e.status, settles: rid });
    stop(1, `${L.PROVIDERS[p].label}: ${e.message}`);
  }
  const r = p === 'gemini' ? parseGemini(res.json) : parseClaude(res.json);
  const { cost, cap_cost } = L.costForCap(p, model, r.usage, L.utcDay(), cfg);
  L.appendUsage({ provider: p, model, caller, ...r.usage, cost, cap_cost, ms: Date.now() - t0, ok: !r.why, status: res.status, settles: rid });
  const todayNow = L.todaySpend(p);
  const costText = cost == null ? 'cost unknown' : `about US$${money(cost)}`;
  const footer = `${model} · ${r.usage.in} in (${r.usage.cached} cached) · ${r.usage.out} out · ${costText} · today US$${money(todayNow)} of ${money(cap)}`;
  if (r.why) stop(1, `${L.PROVIDERS[p].label} gave no answer (${String(r.why).slice(0, 60)}). ${footer}`);
  if (o.json) process.stdout.write(JSON.stringify({ ok: true, provider: p, model, answer: L.redact(r.answer), usage: r.usage, cost_usd: cost == null ? null : +cost.toFixed(6), today_usd: +todayNow.toFixed(6), cap_usd: cap }) + '\n');
  else process.stdout.write(L.redact(r.answer) + (r.answer.endsWith('\n') ? '' : '\n'));
  process.stderr.write(footer + '\n');
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2)); JSON_OUT = !!o.json;
    if (o.help || !o.provider) { process.stdout.write(USAGE + '\n'); return; }
    await run(o);
  } catch (e) {
    const code = e instanceof Stop ? e.exit : 1;
    const msg = L.redact(e instanceof Stop ? e.message : `wk-ask: ${e.message}`);
    if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, provider: PROVIDER, exit: code, error: msg }) + '\n');
    process.stderr.write(msg + '\n');
    process.exitCode = code;
  }
}
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) main();
