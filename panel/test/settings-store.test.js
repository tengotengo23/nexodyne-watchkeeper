'use strict';
// P2-272 (B2-8): the shared settings.json is the only source for the synced keys. Temp folders only; REPROMPT_DATA_DIR points at one.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fakeVscode = {
  Uri: { file: (f) => ({ fsPath: f }) },
  workspace: { isTrusted: true, getConfiguration: () => ({ get: () => '' }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: {}, commands: {}, env: {},
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? fakeVscode : origLoad.call(this, req, ...rest); };
const { RePromptController, resolveDataDir, HOOK_SYNC_KEYS } = require('../src/reprompt-controller.js');

const ENV = ['HOME', 'APPDATA', 'XDG_DATA_HOME', 'REPROMPT_DATA_DIR', 'PLUGIN_DATA', 'REPROMPT_SKIP_HOOK_SYNC', 'REPROMPT_HOOK_SETTINGS_PATHS'];
function setup(files = {}) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-settings-store-'));
  for (const k of ENV) delete process.env[k];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-settings-home-'));
  process.env.HOME = home;
  process.env.REPROMPT_DATA_DIR = dir;
  if (files.store) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(files.store));
  const mem = new Map(Object.entries(files.globalState || {}));
  const globalState = { get: (k, d) => (mem.has(k) ? mem.get(k) : d), update: async (k, v) => { mem.set(k, v); } };
  const restore = () => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  return { home, dir, mem, globalState, file: path.join(dir, 'settings.json'), restore, ctl: () => new RePromptController({ globalState }) };
}
const readFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('a hand edit of the shared file survives the next panel save', async () => {
  const t = setup({ store: { provider: 'offline_template', hookAutoAll: true } });
  try {
    const c = t.ctl();
    await c.saveSettings({ defaultMode: 'fast' });
    const edit = readFile(t.file); edit.provider = 'claude'; edit.hookAutoAll = false;
    fs.writeFileSync(t.file, JSON.stringify(edit));
    await c.saveSettings({ autoRewriteDelayMs: 2000 });
    const after = readFile(t.file);
    assert.equal(after.provider, 'claude'); assert.equal(after.hookAutoAll, false);
    assert.equal(after.defaultMode, 'fast'); assert.equal(after.autoRewriteDelayMs, 2000);
    assert.equal(c.getSettings().provider, 'claude', 'getSettings reads the file every time');
  } finally { t.restore(); }
});

test('keys the panel does not know survive a save, and no temp file is left', async () => {
  const t = setup({ store: { claudeCodeRewrite: 'always', somethingElse: { a: 1 } } });
  try {
    await t.ctl().saveSettings({ provider: 'offline_template' });
    const after = readFile(t.file);
    assert.equal(after.claudeCodeRewrite, 'always'); assert.deepEqual(after.somethingElse, { a: 1 }); assert.equal(after.provider, 'offline_template');
    assert.deepEqual(fs.readdirSync(t.dir).filter((n) => n.endsWith('.tmp')), []);
  } finally { t.restore(); }
});

test('globalState no longer overrides the file, and holds no synced key after a save', async () => {
  const t = setup({ store: { provider: 'claude', hookAutoAll: false }, globalState: { 'reprompt.settings.v1': { provider: 'gemini', hookAutoAll: true, openInFloatingWindow: false } } });
  try {
    const c = t.ctl();
    const s = c.getSettings();
    assert.equal(s.provider, 'claude'); assert.equal(s.hookAutoAll, false); assert.equal(s.openInFloatingWindow, false, 'window state still comes from globalState');
    await c.saveSettings({ defaultMode: 'deep', openInFloatingWindow: true });
    const gs = t.mem.get('reprompt.settings.v1');
    assert.deepEqual(Object.keys(gs).filter((k) => HOOK_SYNC_KEYS.includes(k)), []);
    assert.equal(gs.openInFloatingWindow, true);
    assert.equal(readFile(t.file).provider, 'claude');
  } finally { t.restore(); }
});

test('migration: a synced key only in globalState is copied into the file once, the file is backed up, and the file wins on a conflict', async () => {
  const t = setup({ store: { provider: 'claude' }, globalState: { 'reprompt.settings.v1': { provider: 'gemini', defaultMode: 'deep', openInFloatingWindow: false } } });
  try {
    const c = t.ctl();
    const f1 = readFile(t.file);
    assert.equal(f1.provider, 'claude', 'file value kept'); assert.equal(f1.defaultMode, 'deep', 'missing key copied');
    const backups = fs.readdirSync(path.join(t.dir, 'settings-backups'));
    assert.equal(backups.length, 1);
    assert.equal(t.mem.get('reprompt.settings.migrated.v2'), true);
    assert.deepEqual(t.mem.get('reprompt.settings.v1'), { openInFloatingWindow: false });
    // a later hand edit is not undone, and a second controller does not migrate again
    const edit = readFile(t.file); delete edit.defaultMode; fs.writeFileSync(t.file, JSON.stringify(edit));
    t.mem.set('reprompt.settings.v1', { defaultMode: 'deep' });
    t.ctl();
    assert.equal(readFile(t.file).defaultMode, undefined, 'migration ran once');
    assert.equal(fs.readdirSync(path.join(t.dir, 'settings-backups')).length, 1);
    assert.ok(c);
  } finally { t.restore(); }
});

test('resolveDataDir: REPROMPT_DATA_DIR first, then PLUGIN_DATA', () => {
  const t = setup();
  try {
    assert.equal(resolveDataDir(), t.dir);
    delete process.env.REPROMPT_DATA_DIR; process.env.PLUGIN_DATA = '/x/plugin-data';
    assert.equal(resolveDataDir(), '/x/plugin-data');
  } finally { t.restore(); }
});

test('migration: keys only in the old per-user Re-Prompt file are merged into the shared file once; the old file stays untouched', () => {
  const t = setup({ store: { provider: 'claude' } });
  try {
    const legacyDir = process.platform === 'win32' ? null : process.platform === 'darwin'
      ? path.join(t.home, 'Library', 'Application Support', 're-prompt') : path.join(t.home, '.local', 'share', 're-prompt');
    if (!legacyDir) return;
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = path.join(legacyDir, 'settings.json');
    fs.writeFileSync(legacy, JSON.stringify({ provider: 'gemini', onlyThere: 7 }));
    const before = fs.readFileSync(legacy, 'utf8');
    t.ctl();
    const f = readFile(t.file);
    assert.equal(f.provider, 'claude', 'the store wins on a conflict'); assert.equal(f.onlyThere, 7);
    assert.equal(fs.readFileSync(legacy, 'utf8'), before, 'old file left in place');
    assert.equal(fs.readdirSync(path.join(t.dir, 'settings-backups')).length, 2, 'both files backed up');
  } finally { t.restore(); }
});

// P2-272 review B, should-fix 12: a shared settings file that exists but does not parse is never overwritten; the write is refused with a plain message.
test('a settings file that does not parse is left byte for byte and the save is refused with a message', async () => {
  const t = setup();
  const shown = [];
  fakeVscode.window.showErrorMessage = (m) => { shown.push(m); };
  try {
    const bad = '{ "provider": "claude", oops \u0000 not json';
    fs.writeFileSync(t.file, bad);
    const c = t.ctl();
    await c.saveSettings({ defaultMode: 'fast', hookAutoAll: true });
    assert.equal(fs.readFileSync(t.file, 'utf8'), bad, 'the file is unchanged');
    assert.deepEqual(fs.readdirSync(t.dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file is left');
    assert.equal(shown.length, 1);
    assert.equal(shown[0], `The settings file ${t.file} could not be read; fix or move it, then try again.`);
    // A JSON array is not a settings object either: also refused, also unchanged.
    fs.writeFileSync(t.file, '[1,2]');
    await c.saveSettings({ defaultMode: 'deep' });
    assert.equal(fs.readFileSync(t.file, 'utf8'), '[1,2]');
    assert.equal(shown.length, 2);
  } finally { delete fakeVscode.window.showErrorMessage; t.restore(); }
});

test('migration is not marked done while the shared file does not parse, and the old keys stay', async () => {
  const t = setup({ globalState: { 'reprompt.settings.v1': { provider: 'gemini', openInFloatingWindow: true } } });
  const shown = [];
  fakeVscode.window.showErrorMessage = (m) => { shown.push(m); };
  try {
    fs.writeFileSync(t.file, 'not json');
    t.ctl();
    await new Promise((r) => setImmediate(r));
    assert.equal(fs.readFileSync(t.file, 'utf8'), 'not json');
    assert.equal(t.mem.get('reprompt.settings.v1').provider, 'gemini', 'the old synced key is kept until it can be written');
    assert.notEqual(t.mem.get('reprompt.settings.migrated.v2'), true);
  } finally { delete fakeVscode.window.showErrorMessage; t.restore(); }
});

test('P2-273: an old shared file moves to the new defaults once; a later choice stays', async () => {
  const t = setup({ store: { claudeCodeRewrite: 'prefix', hookAutoAll: true, provider: 'claude' } });
  try {
    const c = t.ctl();
    assert.equal(c.getSettings().hookAutoAll, false, 'read through the migration');
    await c.saveSettings({ defaultMode: 'fast' });
    let after = readFile(t.file);
    assert.equal(after.settingsVersion, 2);
    assert.equal(after.claudeCodeRewrite, 'words');
    assert.equal(after.hookAutoAll, false);
    assert.equal(after.provider, 'claude', 'other choices stay');
    await c.saveSettings({ hookAutoAll: true });
    after = readFile(t.file);
    assert.equal(after.hookAutoAll, true, 'a choice made after the move stays');
    assert.equal(c.getSettings().hookAutoAll, true);
  } finally { t.restore(); }
});
