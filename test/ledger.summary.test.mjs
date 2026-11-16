import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '../bin/wk-ledger.mjs');
const run = (ledger, args, input) => spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, WK_LEDGER: ledger }, input, encoding: 'utf8' });

test('summary totals tokens per item and model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-sum-')), L = path.join(dir, 'ledger.jsonl'), at = new Date().toISOString();
  const row = (i, cr, cw, o) => JSON.stringify({ at, item: 'x', model: 'm', cost_usd: 0.5, in: i, cache_read: cr, cache_write: cw, out: o });
  fs.writeFileSync(L, [row(10, 100, 5, 7), row(20, 200, 6, 8)].join('\n') + '\n');
  const r = run(L, ['summary']);
  assert.equal(r.status, 0);
  for (const h of ['cache_read', 'cache_write', 'out']) assert.match(r.stdout, new RegExp(h));
  assert.match(r.stdout, /\b30\b/); assert.match(r.stdout, /\b300\b/); assert.match(r.stdout, /\b11\b/); assert.match(r.stdout, /\b15\b/);
});

test('add stores the cache write tokens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-add-')), L = path.join(dir, 'ledger.jsonl');
  const r = run(L, ['add', 'x'], JSON.stringify({ usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 } }));
  assert.equal(JSON.parse(r.stdout).cache_write, 3);
});
