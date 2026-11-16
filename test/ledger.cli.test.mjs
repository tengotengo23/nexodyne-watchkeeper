import test from 'node:test'; import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const CLI = path.join(import.meta.dirname, '..', 'bin', 'wk-ledger.mjs');
const run = (input, ...args) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-ledger-cli-')); const ledger = path.join(dir, 'ledger.jsonl');
  const r = spawnSync('node', [CLI, ...args], { input, encoding: 'utf8', env: { ...process.env, WK_LEDGER: ledger, WK_STEWARD_DIR: dir } });
  return { ...r, wrote: fs.existsSync(ledger) && fs.readFileSync(ledger, 'utf8').trim() !== '' };
};

for (const [name, input] of [['empty stdin', ''], ['not JSON', 'hello\n']]) {
  test(`ledger add: ${name} says what it expects, exits 1, writes no row`, () => {
    const r = run(input, 'add', 'P2-x');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^wk-ledger add: expected a `claude -p` result object on stdin \(the `--output-format json` output, or the last line of `--output-format stream-json`\), got (nothing|text that is not a JSON object); no row written/);
    assert.doesNotMatch(r.stderr, /SyntaxError|anonymous_script/);
    assert.equal(r.wrote, false);
  });
}

test('ledger add: takes the last line of a stream-json run', () => {
  const r = run('{"type":"system"}\n{"type":"result","total_cost_usd":0.5}\n', 'add', 'P2-x');
  assert.equal(r.status, 0); assert.equal(r.wrote, true);
});

test('ledger add: books the run under the model that cost most, not the first listed (a Haiku helper listed before Fable)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-ledger-cli-')); const ledger = path.join(dir, 'ledger.jsonl');
  const input = JSON.stringify({ type: 'result', total_cost_usd: 3.85, modelUsage: { 'claude-haiku-5-5': { costUSD: 0.01 }, 'claude-fable-5-1': { costUSD: 3.84 } } });
  const r = spawnSync('node', [CLI, 'add', 'ask-claude x'], { input, encoding: 'utf8', env: { ...process.env, WK_LEDGER: ledger, WK_STEWARD_DIR: dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8').trim()).model, 'claude-fable-5-1');
});
