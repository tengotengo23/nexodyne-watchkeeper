// Render check for the W panel (P2-205): the real webview HTML, CSS and script with fixture data in headless Chrome.
// Matrix: dark and light theme variables x base font 13 and 20 px x prefers-reduced-motion reduce and no-preference, at a 300 px sidebar.
// Counts console errors and CSP violations, checks horizontal overflow and text in boxes, and saves screenshots to dist/screens/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launch } from '../scripts/puppeteer.mjs';

const require = createRequire(import.meta.url);
const D = require('../src/data.js');
const R = require('../src/render.js');
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..');
const screens = process.env.WK_SCREENS ? path.resolve(process.env.WK_SCREENS) : path.join(root, '..', 'dist', 'screens'); fs.mkdirSync(screens, { recursive: true });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wk-render-'));
const put = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
const EVIL = '<img src=x onerror="window.__xss=1">Fix the "quotes" & <b>tags</b>';

// ---------------------------------------------------------------- fixture folders
function fixture({ kill = false, meterAgeMin = 13.2 } = {}) {
  const base = tmp(), now = Date.now();
  const plugin = path.join(base, 'plugin'), data = path.join(base, 'wk'), claude = path.join(base, 'claude'), orch = path.join(base, 'orch');
  const pace = { decision: 'slow', reason: 'ahead', code: 0, used: 0.33, elapsed: 0.313, target: 0.313, behindPoints: -1.7, limit: 0.8, reservePoints: 20, reserveHeld: true,
    reserveReleaseAt: new Date(now + 90 * 3600e3).toISOString(), hoursLeft: 115.5, resetsAt: new Date(now + 115.5 * 3600e3).toISOString(), meterAgeMin, fiveHour: 0.42 };
  put(path.join(plugin, 'bin', 'wk-ledger.mjs'), `console.log(${JSON.stringify(JSON.stringify(pace))});`);
  put(path.join(plugin, 'config', 'gates.json'), JSON.stringify({ kill_switch: { file: path.join(data, 'KILL') } }));
  const at = h => new Date(now - h * 3600e3).toISOString();
  put(path.join(data, 'ledger.jsonl'), [
    { at: at(2), item: 'T-178-wake-3', model: 'claude-sonnet-5-5', cost_usd: 0.2007, in: 32, cache_read: 578858, cache_write: 10542, out: 5786, lens: 'quality' },
    { at: at(5), item: 'T-178-wake-2', model: 'claude-sonnet-5-5', cost_usd: 0.1373, in: 18, cache_read: 298012, out: 3437 },
    { at: at(30), item: 'T-205-a-rather-long-item-name-that-should-wrap-nicely-in-a-narrow-sidebar', model: 'claude-opus-5-5', cost_usd: 1.25, in: 120, cache_read: 1200000, out: 22000 },
    { at: at(50), item: EVIL, model: 'claude-haiku-4-5', cost_usd: 0.02, in: 5, cache_read: 100, out: 40 },
  ].map(o => JSON.stringify(o)).join('\n') + '\n{bad line\n');
  if (kill) put(path.join(data, 'KILL'), 'x');
  D.appendInbox(data, 'recommendation', 'Prefer Sonnet for the nightly checks; keep Opus for reviews.');
  // P2-208: questions Gemini asked Claude (answered, answering now, failed with a hostile preview)
  const adv = (id, meta, answer) => { put(path.join(data, 'advice', id, 'meta.json'), JSON.stringify({ id, from: 'gemini', ...meta })); if (answer) put(path.join(data, 'advice', id, 'answer.md'), answer); };
  adv('20261111-101500-first-launch-age-brackets', { status: 'answered', asked_at: at(1), finished_at: at(0.9), cost_usd: 3.42,
    preview: 'First launch: should every new app open with the parent choosing the age bracket (2–4, 4–7, 8–11, 12–15), or only apps whose content changes by age? Should settings sit behind a parental gate?' }, 'Answer: only when content changes by age.');
  adv('20261111-111500-breathing-timer-name', { status: 'asking', pid: process.pid, asked_at: at(0.05), preview: 'Name for the calm breathing timer: three options, each checked in English, Georgian and Russian.' });
  adv('20261111-091500-evil', { status: 'failed', error: 'timed out', asked_at: at(3), preview: EVIL });
  D.appendInbox(data, 'rule', EVIL + ' and a long rule text that goes on and on to check the clamp in a narrow sidebar at large text sizes, with more words, and more words again, and then some more words to be sure.');
  const proj = path.join(claude, 'projects', '-Users-owner-Projects-nexodyne');
  const sess = (id, lines, minsAgo) => { const f = put(path.join(proj, id + '.jsonl'), lines.map(o => JSON.stringify(o)).join('\n') + '\n'); const t = new Date(now - minsAgo * 60e3); fs.utimesSync(f, t, t); return f; };
  const u = (text, cwd = '/Users/owner/Projects/nexodyne') => ({ type: 'user', cwd, message: { role: 'user', content: text } });
  const a = model => ({ type: 'assistant', message: { model, content: [] } });
  sess('11111111-aaaa', [u('ignored'), { type: 'ai-title', aiTitle: 'Watchkeeper Stage 1 wake-ups' }, a('claude-opus-5-5')], 1);
  sess('22222222-bbbb', [u(EVIL), a('claude-fable-5-2')], 4);
  sess('33333333-cccc', [u('Supercalifragilisticexpialidocious-and-a-very-long-unbroken-word-to-test-wrapping-in-the-panel'), a('claude-sonnet-5-5')], 90);
  sess('44444444-dddd', [u('A quiet session from the morning', '/Users/owner/Projects/kidguard'), a('claude-haiku-4-5')], 600);
  const meta = (sid, id, o, minsAgo) => { const f = put(path.join(proj, sid, 'subagents', id + '.meta.json'), JSON.stringify(o)); const g = put(path.join(proj, sid, 'subagents', id + '.jsonl'), '{}\n'); const t = new Date(now - minsAgo * 60e3); fs.utimesSync(f, t, t); fs.utimesSync(g, t, t); };
  meta('11111111-aaaa', 'agent-1', { description: 'Build the W panel extension', model: 'opus', effort: 'high' }, 1);
  meta('11111111-aaaa', 'agent-2', { description: 'Fresh review of README and CLI text', model: 'fable', effort: 'high', finished: true }, 40);
  meta('11111111-aaaa', 'agent-3', { description: 'Package 3: meter pace line', model: 'sonnet', effort: 'medium', finished: true }, 70);
  meta('22222222-bbbb', 'agent-4', { description: EVIL, model: 'haiku', effort: 'low' }, 120);
  put(path.join(orch, 'locks', 'other'), '32867|T-205 Panel|2026-11-11 10:30\n');
  put(path.join(orch, 'locks', 'site'), '74913|T-206 Shop packages|2026-11-11 10:35\n');
  // P2-223: open questions (one about money, one without a recommendation, one long, seven open so "Show all" shows), a stub nx that is never run here
  const long = 'T-216 The do-it-yourself page: should the price table sit above the steps or below them? Above shows the cost first, which some visitors like; below lets them see the work before the price, which reads calmer. A third way is a short line at the top that links down to the table, so a visitor who wants the price first can jump there, and one who wants the steps first reads on.';
  put(path.join(orch, 'QUESTIONS.md'), ['# Questions for the user', '',
    '- [x] Q100 (2026-11-10 09:00, tab ?): Ticked already. Recommended: no.',
    '- [ ] Q101 (2026-11-11 09:00, tab ?): T-201 Keep the old sign-in page for a week? Recommended: yes, then remove it.',
    '- [ ] Q102 (2026-11-11 10:00, tab ?): T-202 Which tone for the welcome email? Recommended: plain and short.',
    '- [ ] Q103 (2026-11-12 10:00, tab ?): T-203 Show the reading time on stories? Recommended: yes.',
    '- [ ] Q104 (2026-11-12 11:00, tab site): Which colour for the new badge? There is no recommendation on this one.',
    `- [ ] Q105 (2026-11-13 11:00, tab ?): ${long} Recommended: above, with the short line.`,
    '- [ ] Q106 (2026-11-14 11:33, tab ?): T-215 Example shop (accounts/direction): switch on the +20 GEL add-on? Recommended: switch on when one customer agrees in writing.',
    `- [ ] Q107 (2026-11-14 11:40, tab ?): ${EVIL} Recommended: ${EVIL}`, ''].join('\n'));
  put(path.join(orch, 'nx'), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(orch, 'nx'), 0o755);
  // P2-223: suggestions, the Gemini queue, Gemini sessions and the routes config
  put(path.join(data, 'suggestions.jsonl'), [
    { id: 'S-20261114-100000-aaaa', at: at(1), from: 'watchkeeper', title: 'Gemini finished "Fix the breathing timer" and the tests pass. Merge it?', detail: '2 files changed, 14 lines added.', action: { type: 'task-merge', ref: '20261114-090000-fix-breathing-timer' } },
    { id: 'S-20261114-110000-bbbb', at: at(0.5), from: 'gemini', title: 'Raise the Pro price to US$20?', detail: 'Three competitors charge more.', action: { type: 'none' } },
    { id: 'S-20261114-080000-cccc', at: at(3), from: 'claude', title: EVIL, detail: EVIL, action: { type: 'none' } },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  const task = (id, meta, diff) => { put(path.join(data, 'tasks', id, 'meta.json'), JSON.stringify({ id, ...meta })); if (diff) put(path.join(data, 'tasks', id, 'change.diff'), 'diff --git a/x b/x\n'); };
  task('20261114-090000-fix-breathing-timer', { title: 'Fix the breathing timer', kind: 'code', model: 'gemini-4-hydrogen-xhigh', model_used: 'gemini-4-hydrogen-high', status: 'verified', created_at: at(3) }, true);
  task('20261114-100000-tidy-the-readme', { title: 'Tidy the README', kind: 'quick', model: 'gemini-4-hydrogen-medium', status: 'queued', created_at: at(1) });
  task('20261114-080000-evil', { title: EVIL, kind: 'ui', model: EVIL, status: 'failed', created_at: at(5), note: EVIL }, true);
  task('20261114-070000-a-very-long-title-for-the-queue', { title: 'A very long task title for the queue that has to wrap in a narrow sidebar at twenty pixels without spilling', kind: 'review', status: 'taken', created_at: at(6) });
  put(path.join(data, 'gemini', 'sessions.jsonl'), [
    { at: at(0.05), conversation_id: 'c1', model: 'gemini-4-hydrogen-xhigh', workspace: '/Users/owner/Projects/nexodyne', reason: 'stop' },
    { at: at(2), conversation_id: 'c2', model: 'gemini-3.8-flash-medium', workspace: '/Users/owner/Projects/kidguard', reason: 'stop' },
    { at: at(4), conversation_id: 'c3', model: EVIL, workspace: '/Users/owner/' + EVIL, reason: 'stop' },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  put(path.join(plugin, 'config', 'gemini.json'), JSON.stringify({ automation_prompt: 'Take the next Watchkeeper task.', routes: {
    read: { model: 'gemini-3.8-flash-medium', fallback: 'gemini-3.8-flash-low', for: 'reading and summaries' }, quick: { model: 'gemini-4-hydrogen-medium', fallback: 'gemini-4-hydrogen-low', for: 'small fixes' },
    code: { model: 'gemini-4-hydrogen-xhigh', fallback: 'gemini-4-hydrogen-high', for: 'everyday coding' }, ui: { model: 'gemini-4-hydrogen-xhigh', fallback: 'gemini-4-hydrogen-high', for: 'screens and layout' },
    plan: { model: 'gemini-4-hydrogen-max', fallback: 'gemini-4-hydrogen-xhigh', for: 'plans' }, hard: { model: 'gemini-4-hydrogen-max', fallback: 'gemini-4-hydrogen-xhigh', for: 'hard bugs' }, review: { model: 'gemini-4-hydrogen-xhigh', fallback: 'gemini-4-hydrogen-high', for: 'reviews' } } }));
  return { pluginPath: plugin, dataDir: data, claudeDir: claude, orchestrationDir: orch };
}

const THEMES = {
  dark: { cls: 'vscode-dark', vars: { foreground: '#cccccc', 'sideBar-background': '#181818', descriptionForeground: '#9d9d9d', focusBorder: '#0078d4', 'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1', 'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'button-border': 'rgba(255,255,255,0.07)', 'input-background': '#313131', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c', 'widget-border': '#313131', errorForeground: '#f85149', 'editorWarning-foreground': '#cca700', 'sideBarTitle-foreground': '#cccccc' } },
  light: { cls: 'vscode-light', vars: { foreground: '#3b3b3b', 'sideBar-background': '#f8f8f8', descriptionForeground: '#3b3b3b', focusBorder: '#005fb8', 'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-hoverBackground': '#0258a8', 'button-secondaryBackground': '#e5e5e5', 'button-secondaryForeground': '#3b3b3b', 'button-border': '#0000001a', 'input-background': '#ffffff', 'input-foreground': '#3b3b3b', 'input-border': '#cecece', 'widget-border': '#e5e5e5', errorForeground: '#f85149', 'editorWarning-foreground': '#bf8803', 'sideBarTitle-foreground': '#3b3b3b' } },
};
const themeCss = (t, px) => `:root{${Object.entries(THEMES[t].vars).map(([k, v]) => `--vscode-${k}:${v};`).join('')}--vscode-font-family:-apple-system,BlinkMacSystemFont,sans-serif;--vscode-font-size:${px}px;--vscode-editor-font-family:Menlo,monospace;}`;

// ---------------------------------------------------------------- tiny static server (the webview's resource origin)
const files = new Map();
const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); } // Chrome asks once per origin; a webview never does
  const f = files.get(req.url.split('?')[0]);
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.type, 'cache-control': 'no-store' }); res.end(f.body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
files.set('/main.css', { type: 'text/css', body: fs.readFileSync(path.join(root, 'media/main.css')) });
files.set('/main.js', { type: 'text/javascript', body: fs.readFileSync(path.join(root, 'media/main.js')) });
for (const t of Object.keys(THEMES)) for (const px of [13, 20]) {
  files.set(`/theme-${t}-${px}.css`, { type: 'text/css', body: themeCss(t, px) });
  files.set(`/page-${t}-${px}.html`, { type: 'text/html', body: R.renderPage({ nonce: 'n' + t + px + 'Abc123', cspSource: origin, styleUris: [`${origin}/theme-${t}-${px}.css`, `${origin}/main.css`], scriptUri: `${origin}/main.js`, bodyClass: THEMES[t].cls }) });
}

const models = {
  main: R.renderSections(await D.collect(fixture(), Date.now())),
  stopped: R.renderSections(await D.collect(fixture({ kill: true, meterAgeMin: 410 }), Date.now())),
  empty: R.renderSections(await D.collect({ pluginPath: '/nonexistent/plugin', dataDir: '/nonexistent/wk', claudeDir: '/nonexistent/claude', orchestrationDir: '/nonexistent/orch' }, Date.now())),
  // P2-212: a stranger from the store: Claude Code sessions, no Watchkeeper plugin, no orchestration folder
  stranger: R.renderSections(await D.collect({ ...fixture(), pluginPath: '/nonexistent/plugin', dataDir: '/nonexistent/wk', orchestrationDir: '' }, Date.now())),
};

const lite = r => r.model === 'stranger' || r.model === 'empty';
const browser = await launch();
const results = [];
let failures = 0;
try {
  const runs = [];
  for (const t of ['dark', 'light']) for (const px of [13, 20]) for (const motion of ['reduce', 'no-preference']) runs.push({ t, px, motion, model: 'main' });
  runs.push({ t: 'dark', px: 20, motion: 'reduce', model: 'stopped' }, { t: 'light', px: 20, motion: 'reduce', model: 'empty' },
    { t: 'light', px: 20, motion: 'reduce', model: 'stranger' }, { t: 'dark', px: 13, motion: 'no-preference', model: 'stranger' });
  for (const r of runs) {
    const page = await browser.newPage();
    const errors = [];
    let control = false;
    page.on('console', m => { if (m.type() === 'error' && !(control && /Content Security Policy/.test(m.text()))) errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('response', res => { if (res.status() >= 400) errors.push(`HTTP ${res.status()} ${res.url()}`); });
    await page.evaluateOnNewDocument(() => {
      window.__posted = []; window.__csp = [];
      document.addEventListener('securitypolicyviolation', e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
      let st; window.acquireVsCodeApi = () => ({ postMessage: m => window.__posted.push(m), getState: () => st, setState: s => { st = s; } });
    });
    await page.setViewport({ width: 300, height: 900, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: r.motion }, { name: 'prefers-color-scheme', value: r.t }]);
    await page.goto(`${origin}/page-${r.t}-${r.px}.html`, { waitUntil: 'load' });
    await page.evaluate(sections => window.postMessage({ type: 'data', sections }, '*'), models[r.model]);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 5000 });
    const checks = await page.evaluate(async () => {
      const fade = getComputedStyle(document.querySelector('[data-slot="pace"]'));
      const out = { ready: window.__posted.some(m => m.cmd === 'ready'), fade: fade.animationName, fadeMs: fade.animationDuration };
      await new Promise(res => setTimeout(res, 300));
      const vw = document.documentElement.clientWidth;
      out.pageOverflow = document.documentElement.scrollWidth - vw;
      out.offenders = [...document.querySelectorAll('body *')].filter(el => { const b = el.getBoundingClientRect(); return b.width && (b.right > vw + 0.5 || b.left < -0.5); })
        .slice(0, 5).map(el => `${el.tagName.toLowerCase()}.${el.className && el.className.baseVal === undefined ? el.className : ''} right=${Math.round(el.getBoundingClientRect().right)}`);
      document.querySelectorAll('details.routes').forEach(d => { d.open = true; });
      out.boxes = [...document.querySelectorAll('button, .badge, .role, dd, dt, .status-word, input, select, textarea, .confirm-note, .wait-rec')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent.trim().slice(0, 30));
      out.xss = window.__xss === 1;
      out.needs = [...document.querySelectorAll('[data-needs]')].map(el => ({ needs: el.getAttribute('data-needs'), seen: el.getBoundingClientRect().height > 0 }));
      out.text = document.body.innerText.length;
      // the inbox box: empty send gives feedback under the box and posts nothing; a real note posts one send message
      const before = window.__posted.length;
      document.querySelector('[data-send="recommendation"]').click();
      out.emptyFeedback = document.getElementById('feedback').textContent;
      out.emptyPosted = window.__posted.length - before;
      const note = document.getElementById('note'); note.value = 'Try the cheaper model first'; note.dispatchEvent(new Event('input'));
      document.querySelector('[data-send="rule"]').click();
      const last = window.__posted[window.__posted.length - 1];
      out.sendOk = last && last.cmd === 'send' && last.kind === 'rule' && last.text === 'Try the cheaper model first';
      const fb = document.getElementById('feedback').getBoundingClientRect(), box = note.getBoundingClientRect();
      out.feedbackBelow = fb.top >= box.bottom;
      window.postMessage({ type: 'result', ok: true, text: 'Saved as a recommendation.', cleared: true }, '*');
      await new Promise(res => setTimeout(res, 50));
      out.cleared = note.value === '' && document.getElementById('feedback').textContent === 'Saved as a recommendation.';
      out.csp = window.__csp.slice();
      return out;
    });
    // P2-223: "Waiting for you" and the Gemini form, in the full panel only
    checks.wait = lite(r) ? null : await page.evaluate(async sections => {
      const o = {}, posted = () => window.__posted[window.__posted.length - 1], wait = ms => new Promise(res => setTimeout(res, ms));
      const $ = s => document.querySelector(s), n0 = () => window.__posted.length;
      const sec = $('section[aria-labelledby="h-waiting"]'), pace = $('section[aria-labelledby="h-pace"]');
      o.waitingFirst = !!sec && !sec.hidden && sec.getBoundingClientRect().top < pace.getBoundingClientRect().top && sec.getBoundingClientRect().top > $('header').getBoundingClientRect().top;
      o.newestFirst = [...document.querySelectorAll('li.wait[data-q]')].map(li => li.getAttribute('data-q')).join(',');
      o.visibleQs = [...document.querySelectorAll('li.wait[data-q]')].filter(li => !li.hidden).length;
      $('[data-cmd="showAll"][data-list="q"]').click(); o.afterShowAll = [...document.querySelectorAll('li.wait[data-q]')].filter(li => !li.hidden).length;
      const more = $('li[data-q="105"] [data-cmd="more"]'); more.click(); o.moreOpens = !$('li[data-q="105"] .more-rest').hidden && more.textContent === 'Less';
      let k = n0(); $('[data-cmd="okQuestion"][data-n="103"]').click(); const p1 = posted();
      o.okPosts = n0() === k + 1 && p1.cmd === 'answerQuestion' && p1.n === '103' && p1.useRecommended === true && p1.confirmed === false;
      o.noOkWithoutRec = !$('[data-cmd="okQuestion"][data-n="104"]');
      k = n0(); const mOk = $('[data-cmd="okQuestion"][data-n="106"]'); mOk.click();
      const note = $('[data-confirm="q106"]'), btns = mOk.parentElement.getBoundingClientRect();
      o.moneyFirst = n0() === k && !note.hidden && note.getBoundingClientRect().top >= btns.bottom - 0.5;
      o.noteFade = getComputedStyle(note).animationName + ' ' + getComputedStyle(note).animationDuration;
      mOk.click(); const p2 = posted(); o.moneySecond = n0() === k + 1 && p2.confirmed === true && p2.n === '106' && note.hidden;
      $('[data-cmd="openAnswer"][data-n="102"]').click();
      const ta = $('#ans-text-102'); o.answerOpens = !$('#ans-102').hidden && document.activeElement === ta;
      ta.value = 'Plain, short, and warm.'; ta.dispatchEvent(new Event('input', { bubbles: true }));
      window.postMessage({ type: 'data', sections: { ...sections, waiting: sections.waiting + '<!-- refreshed -->' } }, '*'); await wait(60);
      o.draftKept = !$('#ans-102').hidden && $('#ans-text-102').value === 'Plain, short, and warm.' && document.activeElement === $('#ans-text-102');
      o.moreKept = !$('li[data-q="105"] .more-rest').hidden;
      $('[data-cmd="sendAnswer"][data-n="102"]').click(); const p3 = posted();
      o.sendPosts = p3.cmd === 'answerQuestion' && p3.n === '102' && p3.text === 'Plain, short, and warm.' && !p3.useRecommended;
      window.postMessage({ type: 'result', ok: true, text: 'Answered Q102.', cleared: true, where: 'waiting', n: '102' }, '*'); await wait(30);
      o.answerCleared = $('#ans-102').hidden && $('#feedback-waiting').textContent === 'Answered Q102.' && $('#feedback-waiting').getBoundingClientRect().top >= sec.querySelector('[data-slot="waiting"]').getBoundingClientRect().bottom - 0.5;
      $('[data-cmd="laterQuestion"][data-n="101"]').click(); o.laterPosts = posted().cmd === 'laterQuestion' && posted().n === '101';
      $('[data-cmd="decide"][data-choice="later"][data-id="S-20261114-100000-aaaa"]').click();
      o.decidePosts = posted().cmd === 'decideSuggestion' && posted().choice === 'later' && posted().id === 'S-20261114-100000-aaaa';
      k = n0(); $('[data-cmd="decide"][data-choice="ok"][data-id="S-20261114-110000-bbbb"]').click(); o.sMoneyFirst = n0() === k && !$('[data-confirm="sS-20261114-110000-bbbb"]').hidden;
      $('[data-slot="waiting"] [data-cmd="openTaskDiff"]').click(); o.diffPosts = posted().cmd === 'openTaskDiff' && posted().id === '20261114-090000-fix-breathing-timer';
      const g = $('section[aria-labelledby="h-gemini"]'); o.geminiShown = !!g && !g.hidden;
      o.queueDiffs = g.querySelectorAll('[data-slot="gemini"] [data-cmd="openTaskDiff"]').length;
      k = n0(); $('[data-cmd="addTask"]').click(); o.emptyTask = n0() === k && /Write a title first/.test($('#feedback-task').textContent);
      const t = $('#task-title'); t.value = 'Fix the timer'; t.dispatchEvent(new Event('input')); $('#task-text').value = 'It skips a second.'; $('#task-kind').value = 'code';
      $('[data-cmd="addTask"]').click(); const p4 = posted();
      o.taskPosts = p4.cmd === 'addTask' && p4.title === 'Fix the timer' && p4.text === 'It skips a second.' && p4.kind === 'code';
      window.postMessage({ type: 'result', ok: true, text: 'Added.', cleared: true, where: 'task' }, '*'); await wait(30);
      o.taskCleared = t.value === '' && $('#task-kind').value === 'auto';
      $('[data-cmd="copyAutomation"]').click(); o.copyPosts = posted().cmd === 'copyAutomation' && Object.keys(posted()).length === 1;
      o.activeLine = /Gemini in Antigravity: 1 session active in the last 10 minutes\./.test(document.body.innerText);
      o.csp = window.__csp.slice(); o.xss = window.__xss === 1;
      window.scrollTo(0, 0);
      return o;
    }, models[r.model]);
    // control, after the counts above: the policy is really enforced (an inline script is blocked and reported)
    control = true;
    checks.cspEnforced = await page.evaluate(async () => {
      const n = window.__csp.length, sc = document.createElement('script'); sc.textContent = 'window.__inline = 1'; document.body.appendChild(sc);
      await new Promise(res => setTimeout(res, 50));
      return window.__inline !== 1 && window.__csp.length > n;
    });
    const name = r.model === 'main' ? `panel-${r.t}-${r.px}px-motion-${r.motion}.png` : `panel-${r.model}-${r.t}-${r.px}px.png`;
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(screens, name.replace('.png', '-top.png')) });
    await page.screenshot({ path: path.join(screens, name), fullPage: true });
    const bad = [];
    if (errors.length) bad.push(`${errors.length} console errors: ${errors[0]}`);
    if (checks.csp.length) bad.push(`${checks.csp.length} CSP violations: ${checks.csp[0]}`);
    if (checks.pageOverflow > 0 || checks.offenders.length) bad.push(`overflow ${checks.pageOverflow}px ${checks.offenders.join('; ')}`);
    if (checks.boxes.length) bad.push(`text overflows its box: ${checks.boxes.join(', ')}`);
    if (checks.xss) bad.push('hostile title ran');
    if (!checks.cspEnforced) bad.push('CSP not enforced (control inline script ran or was not reported)');
    if (!checks.ready) bad.push('no ready message');
    if (checks.fade !== 'wk-fade' || checks.fadeMs !== '0.24s') bad.push(`fade is ${checks.fade} ${checks.fadeMs}`);
    if (checks.emptyPosted !== 0 || !/Write something/.test(checks.emptyFeedback)) bad.push('empty send not caught');
    if (!checks.sendOk) bad.push('send message wrong');
    if (!checks.feedbackBelow) bad.push('feedback not under the box');
    if (!checks.cleared) bad.push('result not shown or box not cleared');
    // P2-212: without the plugin only the sessions and the about note show; with it, everything but the about note shows (P2-223: Waiting for you and Gemini too)
    const wrong = checks.needs.filter(x => x.seen !== (lite(r) ? x.needs === 'no-plugin' : x.needs !== 'no-plugin'));
    if (checks.wait) {
      const w = checks.wait, want = { waitingFirst: true, newestFirst: '107,106,105,104,103,102,101', visibleQs: 5, afterShowAll: 7, moreOpens: true, okPosts: true, noOkWithoutRec: true, moneyFirst: true,
        noteFade: 'wk-fade 0.24s', moneySecond: true, answerOpens: true, draftKept: true, moreKept: true, sendPosts: true, answerCleared: true, laterPosts: true, decidePosts: true, sMoneyFirst: true,
        diffPosts: true, geminiShown: true, queueDiffs: 2, emptyTask: true, taskPosts: true, taskCleared: true, copyPosts: true, activeLine: true, xss: false };
      for (const [key, v] of Object.entries(want)) if (w[key] !== v) bad.push(`T-223 ${key}: ${JSON.stringify(w[key])}`);
      if (w.csp.length) bad.push(`${w.csp.length} CSP violations after the T-223 clicks: ${w.csp[0]}`);
    }
    if (checks.needs.length !== 9 || wrong.length) bad.push(`sections shown wrongly: ${wrong.map(x => x.needs + (x.seen ? ' shown' : ' hidden')).join(', ') || checks.needs.length + ' marked'}`);
    failures += bad.length ? 1 : 0;
    results.push({ name, console: errors.length, csp: checks.csp.length, overflow: checks.pageOverflow, fade: `${checks.fade} ${checks.fadeMs}`, ok: !bad.length, bad });
    await page.close();
  }
} finally { await browser.close(); server.close(); }

for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}  console errors ${r.console}, CSP violations ${r.csp}, overflow ${r.overflow}px, ${r.fade}${r.bad.length ? '\n     ' + r.bad.join('\n     ') : ''}`);
console.log(`render check: ${results.length - failures} of ${results.length} views passed; screenshots in ${screens}`);
process.exit(failures ? 1 : 0);
