#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json` as wk-job runs it (P2-227). Only the job tests use it (WK_CLAUDE_BIN=<this file>).
// It reads the prompt from stdin and prints stream-json events: system/init, assistant (text and tool_use), a permission_denied event,
// and result (with permission_denials). It never touches the network. Each call appends {argv, stdin, pid, cwd} to FAKE_JOB_LOG,
// or to $WK_HOME/fake-claude.jsonl when that is unset (the panel's actions pass only HOME, PATH and WK_HOME on to wk-job).
// Knobs (all optional):
//   FAKE_JOB_MODE   ok (default) | fail (result is an error, exit 1) | hang (prints init, then waits) | crash (exit 3, no result)
//   FAKE_JOB_IGNORE_TERM=1   ignore SIGTERM (so the runner needs SIGKILL)
//   FAKE_JOB_CHILD_PID=<file>   start a grandchild in the same process group and write its pid there
//   FAKE_JOB_SECRET=1   put a secret-shaped string and the home folder in the text and the tool input
//   FAKE_JOB_SECRET_TEXT=<text>   put this text there instead (the review's extra shapes)
//   FAKE_JOB_SESSION   the session id to report (default: the --resume value, else "sess-0001")
//   FAKE_JOB_MISSING=<id,id>   these --model values are "not available": it replays model-missing.ndjson (the real 404 sample) and exits 1
//   FAKE_JOB_BUSY=<n>   the first n calls (counted in $WK_HOME/fake-busy-count) answer with model-busy.json (a 429) and exit 1
// A full model id (claude-...) prints the [claude-code:unrecognized_model] tag on stderr, as the real CLI does even when it works.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2), env = process.env;
if (!argv.includes('-p')) process.exit(0);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const write = o => new Promise(r => process.stdout.write(JSON.stringify(o) + '\n', () => r()));
const mode = env.FAKE_JOB_MODE || 'ok';
if (env.FAKE_JOB_IGNORE_TERM === '1') process.on('SIGTERM', () => {});

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { stdin += d; });
process.stdin.on('end', async () => {
  const logFile = env.FAKE_JOB_LOG || (env.WK_HOME && `${env.WK_HOME}/fake-claude.jsonl`);
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ argv, stdin, pid: process.pid, cwd: process.cwd() }) + '\n');
  if (env.FAKE_JOB_CHILD_PID) {
    const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.writeFileSync(env.FAKE_JOB_CHILD_PID, String(c.pid));
  }
  const session_id = env.FAKE_JOB_SESSION || val('--resume') || 'sess-0001';
  const model = String(val('--model')), FX = path.dirname(new URL(import.meta.url).pathname);
  if (model.startsWith('claude-')) process.stderr.write(`[claude-code:unrecognized_model] {"model":"${model}","query_source":"sdk"}\n`);
  if (String(env.FAKE_JOB_MISSING || '').split(',').includes(model)) {
    for (const l of fs.readFileSync(path.join(FX, 'model-missing.ndjson'), 'utf8').trim().split('\n')) await new Promise(r => process.stdout.write(l.replaceAll('claude-nonexistent-9', model) + '\n', r));
    process.exit(1);
  }
  if (Number(env.FAKE_JOB_BUSY) > 0 && env.WK_HOME) {
    const cf = path.join(env.WK_HOME, 'fake-busy-count'), n = (Number(fs.existsSync(cf) ? fs.readFileSync(cf, 'utf8') : 0) || 0) + 1;
    fs.writeFileSync(cf, String(n));
    if (n <= Number(env.FAKE_JOB_BUSY)) {
      await write({ type: 'system', subtype: 'init', session_id, model, permissionMode: val('--permission-mode') });
      await write(JSON.parse(fs.readFileSync(path.join(FX, 'model-busy.json'), 'utf8')));
      process.exit(1);
    }
  }
  await write({ type: 'system', subtype: 'init', session_id, model: model.startsWith('claude-') ? model : `claude-${model}-test`, permissionMode: val('--permission-mode'), tools: ['Bash'], cwd: process.cwd() });
  await write({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day' } });
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'crash') { process.stderr.write('fake: crashed\n'); process.exit(3); }
  const secret = env.FAKE_JOB_SECRET === '1' ? ` key sk-ant-${'a'.repeat(30)} in ${env.HOME}/x` : env.FAKE_JOB_SECRET_TEXT ? ` ${env.FAKE_JOB_SECRET_TEXT}` : '';
  const first = stdin.split('\n')[0].slice(0, 100);
  await write({ type: 'assistant', session_id, message: { content: [{ type: 'text', text: `Working on: ${first}${secret}` },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `ls ${env.HOME}/Projects${secret}`, description: 'list' } }] } });
  await write({ type: 'user', session_id, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] } });
  await write({ type: 'system', subtype: 'permission_denied', session_id, tool_name: 'WebFetch' });
  await write({ type: 'assistant', session_id, message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } });
  if (mode === 'fail') {
    await write({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id, total_cost_usd: 0.5, num_turns: 7, result: 'Ran out of turns.', permission_denials: [] });
    process.exit(1);
  }
  await write({ type: 'result', subtype: 'success', is_error: false, session_id, total_cost_usd: 0.25, num_turns: 3,
    result: `Done: ${first}. Needs the owner: nothing.${secret}`, permission_denials: [{ tool_name: 'Write', tool_use_id: 't2', tool_input: {} }] });
  process.exit(0);
});
