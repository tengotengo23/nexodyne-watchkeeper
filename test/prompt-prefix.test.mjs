// P2-272: panel/src/prompt-prefix.js (JS mirror) against the shared vectors that the Python grammar also passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pp = require(path.join(here, "..", "panel", "src", "prompt-prefix.js"));
const engine = require(path.join(here, "..", "panel", "src", "reprompt-engine.js"));
const data = JSON.parse(readFileSync(path.join(here, "fixtures", "prompt-prefix-vectors.json"), "utf8"));

test("constants match the vectors", () => {
  assert.equal(pp.AUTO_FLOOR_CHARS, data.auto_floor_chars);
  assert.equal(pp.SHORT_REPLY_CHARS, data.short_reply_chars);
});

test("every vector classifies the same as in Python", () => {
  assert.ok(data.cases.length >= 40);
  for (const c of data.cases) {
    const want = { kind: c.kind, prefix: c.prefix, body: c.body, mode: c.mode, task_id: c.task_id };
    assert.deepEqual(pp.classify(c.input), want, JSON.stringify(c.input));
  }
});

test("helpers agree with classify", () => {
  for (const c of data.cases) {
    if (c.kind === "raw") assert.equal(pp.parseRaw(c.input), c.body);
    if (c.kind === "rewrite") assert.deepEqual(pp.parseRewrite(c.input), { prefix: c.prefix, body: c.body, mode: c.mode });
    if (c.kind === "none" || c.kind === "empty") {
      assert.equal(pp.parseRaw(c.input), null);
      assert.equal(pp.parseRewrite(c.input), null);
    }
  }
});

test("P2-273 word rule: the same answers as Python", () => {
  assert.equal(pp.AUTO_OVER_WORDS, data.auto_over_words);
  assert.ok(data.word_cases.length >= 20);
  for (const c of data.word_cases) {
    assert.equal(pp.wordCount(c.input), c.words, c.note);
    assert.equal(pp.wantsAutoRewrite(c.input, data.auto_over_words), c.auto, c.note);
  }
});

test("P2-273 word rule threshold setting", () => {
  const long = Array(31).fill("word").join(" ");
  assert.equal(pp.wantsAutoRewrite(long), true);
  assert.equal(pp.wantsAutoRewrite(long, 0), false);
  assert.equal(pp.wantsAutoRewrite(long, 31), false);
  assert.equal(pp.wantsAutoRewrite(long, "30"), true);
  for (const [value, want] of [[null, 30], [undefined, 30], [true, 30], ["", 30], ["x", 30], [-1, 30], ["12.7", 12], [0, 0], [Infinity, 30]]) {
    assert.equal(pp.autoOverWords(value), want, String(value));
  }
});

test("P2-273 threshold values match the Python grammar (over_words_cases)", () => {
  assert.ok(data.over_words_cases.length >= 20);
  for (const c of data.over_words_cases) assert.equal(pp.autoOverWords(c.value), c.want, c.note);
});

test("P2-273 settings move to version 2 once (migrate_cases)", () => {
  assert.equal(pp.SETTINGS_VERSION, 2);
  for (const c of data.migrate_cases) {
    const before = JSON.stringify(c.in);
    assert.deepEqual(pp.migrateSettings(c.in), c.out, c.note);
    assert.equal(JSON.stringify(c.in), before, "the input is not changed");
  }
  assert.deepEqual(pp.migrateSettings(null), { settingsVersion: 2 });
});

test("the panel engine exposes the same grammar", () => {
  assert.deepEqual(engine.parsePromptPrefix("rp-bug: crash on save"), pp.classify("rp-bug: crash on save"));
  assert.equal(engine.parseRawPrefix("/wk raw: as is"), "as is");
  assert.deepEqual(engine.parseRewritePrefix(":rp tidy"), { prefix: "rp", body: "tidy", mode: null });
});
