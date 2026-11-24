// Drift test: the Re-Prompt app page has one source and two byte-for-byte copies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SOURCE, COPIES, drift } from '../bin/wk-sync-app-page.mjs';

test('app page copies match reprompt/ui/reprompt_app.html', () => {
  assert.deepEqual(drift(), [], 'run: node bin/wk-sync-app-page.mjs');
});
test('source keeps the single sync label and the host check', () => {
  const s = fs.readFileSync(SOURCE, 'utf8');
  assert.ok(!/Sync Trending|Sync \/ Update Vault/.test(s));
  assert.ok(s.includes('typeof acquireVsCodeApi'));
  assert.ok(s.includes('ui/initialize'));
  assert.equal(COPIES.length, 2);
});
