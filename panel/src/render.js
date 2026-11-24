'use strict';
// The W panel's HTML (P2-205). Pure functions: data in, escaped HTML out. Every string that came from a file goes through esc().
const D = require('./data');

const esc = v => String(v == null ? '' : v).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;
const TARGET_LABELS = { claude: 'Claude Code', antigravity: 'Antigravity IDE', general: 'General', auto: 'Auto' };
const MODE_LABELS = { balanced: 'Balanced', spec: 'Deep Spec', bugfix: 'Bug Fix', refactor: 'Refactor', concise: 'Concise', auto: 'Auto' };
const ROUTE_LABELS = { auto: 'Auto (by quota)', carbon: 'Gemini only (API key or queue)', claude: 'Prefer Claude Code', gemini: 'Prefer Gemini (API key or queue)' };

function modelBadgeClass(model = '', provider = '') {
  const s = `${model} ${provider}`.toLowerCase();
  if (s.includes('graphify')) return 'model-badge model-badge-graphify';
  if (s.includes('carbon') || s.includes('orchestrator')) return 'model-badge model-badge-carbon';
  if (s.includes('claude') || s.includes('opus') || s.includes('sonnet') || s.includes('haiku') || s.includes('fable')) return 'model-badge model-badge-claude';
  if (s.includes('gemini') || s.includes('agy') || s.includes('hydrogen') || s.includes('neon') || s.includes('argon')) return 'model-badge model-badge-gemini';
  return 'model-badge';
}

function when(ms, now = Date.now()) {
  const d = new Date(ms), n = new Date(now), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === n.toDateString()) return `today ${hm}`;
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}`;
}
function ago(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}
function span(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'under a minute';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} days`;
}
const pct = x => `${Math.round(x * 100)}%`;
const usd = x => 'US$' + x.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function tok(n) {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}
// A lock's time is local "YYYY-MM-DD HH:MM"; show "today HH:MM" or the day and date, so an old lock is plain to see.
function lockSince(s, now = Date.now()) {
  const x = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s));
  if (!x) return String(s);
  return when(new Date(+x[1], +x[2] - 1, +x[3], +x[4], +x[5]).getTime(), now);
}
const tilde = (p, home) => (home && typeof p === 'string' && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);

// Small shapes so state never rests on colour alone.
const SHAPES = {
  running: '<svg class="shape" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5"/></svg>',
  holding: '<svg class="shape" viewBox="0 0 14 14" aria-hidden="true"><rect x="2.5" y="2" width="3.4" height="10" rx="1"/><rect x="8.1" y="2" width="3.4" height="10" rx="1"/></svg>',
  stopped: '<svg class="shape" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="1.5"/></svg>',
  unknown: '<svg class="shape hollow" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5"/></svg>',
  done: '<svg class="shape hollow" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.5l2.6 2.6L11 4.6"/></svg>',
};

// P2-272 4B: the task splitter's plan card (panel/src/dag-runner.js keeps turn.dag). Every string comes from the planner or the
// engine, so all of it goes through esc(); buttons carry only the session and turn ids (data-cmd, no inline handlers).
const DAG_STATE_WORDS = { pending: 'Not started', queued: 'Queued for Antigravity', running: 'Running', passed: 'Passed', failed: 'Failed', stopped: 'Stopped', skipped: 'Skipped' };
const DAG_STATE_SHAPES = { pending: SHAPES.unknown, queued: SHAPES.holding, running: SHAPES.running, passed: SHAPES.done, failed: SHAPES.stopped, stopped: SHAPES.stopped, skipped: SHAPES.unknown };
const DAG_HEADS = {
  plan: 'Split into steps: run them?',
  running: 'Running the steps',
  waiting: 'Waiting for Antigravity',
  'merge-offer': 'Every step passed',
  merged: 'Merged',
  'merge-declined': 'Not merged',
  'declined-plan': 'Not run',
  failed: 'A step failed',
  stopped: 'Stopped',
};
function dagCard(t, sessionId, untrusted) {
  const d = t.dag && typeof t.dag === 'object' ? t.dag : {};
  const nodes = arr(d.nodes);
  const byId = new Map(nodes.map(n => [n && n.id, n]));
  const steps = d.steps && typeof d.steps === 'object' ? d.steps : {};
  let waves = arr(d.waves).filter(w => arr(w).length);
  if (!waves.length && nodes.length) waves = [nodes.map(n => n.id)];
  const phase = String(d.phase || 'plan');
  const ids = `data-session-id="${esc(sessionId)}" data-turn-id="${esc(t.id)}"`;
  const off = untrusted ? ' disabled' : '';
  // S13: every button has a stable id, so focus can move to the next useful control after a click.
  const bid = (name) => `id="dag-${name}-${esc(t.id)}"`;
  const head = DAG_HEADS[phase] || 'Steps';
  const headShape = phase === 'running' ? SHAPES.running : phase === 'plan' || phase === 'waiting' || phase === 'merge-offer' ? SHAPES.holding
    : phase === 'failed' || phase === 'stopped' ? SHAPES.stopped : SHAPES.done;
  let html = `<section class="chat-confirm-card dag-card" data-dag-card="${esc(t.id)}" aria-label="${esc(head)}">`
    + `<div class="confirm-head"><span class="confirm-title">${headShape}${esc(head)}</span>`
    + `<span class="row-meta">${esc(plural(nodes.length, 'step'))} in ${esc(plural(waves.length, 'wave'))}</span></div>`;
  if (d.branch) html += `<p class="hint">Branch: <code>${esc(d.branch)}</code>. Nothing reaches it until you merge.</p>`;
  waves.forEach((w, wi) => {
    html += `<div class="dag-wave"><p class="label">Wave ${wi + 1}${arr(w).length > 1 ? ' (side by side)' : ''}</p><ol class="dag-steps">`;
    for (const id of arr(w)) {
      const n = byId.get(id) || { id };
      const st = steps[id] && typeof steps[id] === 'object' ? steps[id] : {};
      const state = DAG_STATE_WORDS[st.state] ? st.state : 'pending';
      const globs = arr(n.ownedGlobs);
      html += `<li class="dag-step dag-step-${esc(state)}">`
        + `<div class="dag-step-head">${DAG_STATE_SHAPES[state]}<span class="dag-step-title">${esc(n.title || n.id)}</span>`
        + `<span class="dag-state">${esc(DAG_STATE_WORDS[state])}</span></div>`
        + `<p class="row-meta">${esc(n.lane || 'Claude Code')}${n.model ? ` · ${esc(n.model)}` : ''}${n.effort ? ` · ${esc(n.effort)}` : ''}${arr(n.dependsOn).length ? ` · after ${esc(arr(n.dependsOn).join(', '))}` : ''}</p>`
        + (globs.length ? `<p class="dag-meta"><span class="label">Files</span> ${globs.map(g => `<code>${esc(g)}</code>`).join(' ')}</p>` : '')
        + (n.verifyCmd ? `<p class="dag-meta"><span class="label">Check</span> <code>${esc(n.verifyCmd)}</code></p>` : '')
        + (st.taskId ? `<p class="hint dag-queued">Queued for Antigravity as task <code>${esc(st.taskId)}</code>. Antigravity takes it when you run /wk-take-task there.</p>`
          // S6: before the run, an Antigravity step says that it will wait for the owner.
          : (n.lane === 'Antigravity queue' && phase === 'plan' ? `<p class="hint dag-queued">Waits for you: run /wk-take-task in Antigravity.</p>` : ''))
        + (st.reason ? `<p class="hint">${esc(st.reason)}</p>` : '')
        + `</li>`;
    }
    html += `</ol></div>`;
  });
  // S13: the result line can take focus (tabindex -1) after Stop, Merge or Not now.
  if (d.message) html += `<p class="hint dag-message" role="status" tabindex="-1" ${bid('msg')}>${esc(d.message)}</p>`;
  if (d.hint && phase === 'waiting') html += `<p class="hint dag-next">${esc(d.hint)}</p>`;
  let buttons = '';
  if (phase === 'plan') {
    buttons = `<button type="button" class="btn" data-cmd="dagRun" ${bid('run')} ${ids}${off}>Run these steps</button>`
      + `<button type="button" class="btn btn-secondary" data-cmd="dagNotNow" ${bid('notnow')} ${ids}>Not now</button>`;
  } else if (phase === 'waiting') {
    // M3: "Check again" asks the engine whether Antigravity has finished; Stop stays beside it.
    buttons = `<button type="button" class="btn" data-cmd="dagCheck" ${bid('check')} ${ids}${off}>Check again</button>`
      + `<button type="button" class="btn btn-secondary" data-cmd="dagStop" ${bid('stop')} ${ids}${off}>Stop</button>`;
  } else if (phase === 'running') {
    buttons = `<button type="button" class="btn btn-secondary" data-cmd="dagStop" ${bid('stop')} ${ids}${off}>Stop</button>`;
  } else if (phase === 'merge-offer') {
    buttons = `<button type="button" class="btn" data-cmd="dagMerge" ${bid('merge')} ${ids}${off}>Merge into ${esc(d.branch || 'your branch')}</button>`
      + `<button type="button" class="btn btn-secondary" data-cmd="dagMergeNo" ${bid('mergeno')} ${ids}>Not now</button>`;
  }
  if (buttons) html += `<div class="actions">${buttons}</div>`;
  return html + `</section>`;
}

// P2-227: one code, two hosts. "antigravity" (the panel, the default) shows every control; "web" (the phone page on your server) leaves out
// what only the Mac may do, with one plain line instead.
const isLocal = m => ((m && m.host) || 'antigravity') === 'antigravity';
const LOCAL_LINE = 'Do this in the Watchkeeper panel on your Mac.';
const localLine = (lead = '') => `<p class="hint local-only">${esc(lead)}${esc(LOCAL_LINE)}</p>`;

// P2-272 (P3-B, spec 3.5): how a session's prompts go. Inline SVG, never colour alone; the words are labels, not prefixes (those live in
// src/prompt-prefix.js only).
const ICONS = {
  raw: '<svg class="shape icon-raw" viewBox="0 0 14 14" aria-hidden="true"><path d="M8.2 1.5L3 8h3.4l-1 4.5L11 6H7.4z"/></svg>',
  reprompt: '<svg class="shape icon-reprompt" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5l1.3 3.7L12 6.5 8.3 7.8 7 11.5 5.7 7.8 2 6.5l3.7-1.3z"/><path d="M11.3 9.6l.5 1.3 1.2.4-1.2.5-.5 1.2-.4-1.2-1.3-.5 1.3-.4z"/></svg>',
};
const PROMPT_BADGE = { raw: ':raw', reprompt: ':re-prompt' };
function promptBadge(mode) {
  const k = mode === 'raw' ? 'raw' : 'reprompt';
  return `<span class="prompt-badge prompt-badge-${k}" title="${k === 'raw' ? 'Sent as typed' : 'Re-prompted before sending'}">${ICONS[k]}${esc(PROMPT_BADGE[k])}</span>`;
}

// P2-272 (P3-B, spec 3.4): the usage card. Reset times in the panel's 24-hour style, local time; a missing window says so.
const hm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function resetLine(ms) {
  const d = new Date(ms);
  return `Resets ${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} at ${hm(ms)}`;
}
const USAGE_LINES = [['seven_day', 'Weekly (7 day)'], ['seven_day_fable', 'Fable limit'], ['seven_day_opus', 'Opus limit'], ['seven_day_sonnet', 'Sonnet limit']];
const ACCOUNT_WORDS = { unknown: 'Not known yet', 'signed-out': 'Not signed in', error: 'Could not be read', stopped: 'Not read: the Stop switch is on', off: 'Not read', 'no-plugin': 'Not read' };
// P2-272 (P3 fixes, S3): no source on this Mac carries the per-model weekly windows yet (steward/meter.json holds seven_day only; the
// status line gives five_hour and seven_day). They come only from a background (headless) Claude run's rate-limit report, so the row says so.
const USAGE_SOURCE = { seven_day_fable: 'comes from a background Claude run', seven_day_opus: 'comes from a background Claude run', seven_day_sonnet: 'comes from a background Claude run' };
function usageRow(label, w, key) {
  if (!w) return `<li class="usage-row usage-missing"><span class="usage-k">${esc(label)}</span><span class="usage-v">no reading yet${USAGE_SOURCE[key] ? ` · ${esc(USAGE_SOURCE[key])}` : ''}</span></li>`;
  // P2-272 (P3 fixes, S8): over 100 % says "over the limit"; the meter stays inside its box.
  const over = w.over || Number(w.pct) > 100;
  return `<li class="usage-row${over ? ' usage-over' : ''}"><span class="usage-k">${esc(label)}</span><span class="usage-v">${esc(String(w.pct))}%${over ? ' · over the limit' : ''}</span>`
    + `<meter class="usage-meter" min="0" max="100" low="70" high="90" optimum="0" value="${esc(String(Math.max(0, Math.min(100, Number(w.pct) || 0))))}" aria-hidden="true"></meter>`
    + `<span class="usage-reset">${esc(resetLine(w.resetsAt))}</span></li>`;
}
function geminiLabelOf(g) {
  const l = g && typeof g.label === 'string' ? g.label.trim() : '';
  return l || 'Gemini / Antigravity';
}
function renderUsage(m) {
  const u = (m && m.usage) || {}, w = u.windows || {}, acc = (m && m.account) || {}, g = (m && m.geminiUsage) || {}, now = (m && m.now) || Date.now();
  let html = `<div class="usage-card">`;
  html += `<div class="usage-block"><h3 class="usage-h">Claude Code</h3>`
    + `<p class="usage-acc"><span class="usage-k">Email:</span> `
    + (acc.state === 'ok' && acc.email ? `<span class="usage-v">${esc(acc.email)}</span>` : `<span class="usage-v usage-missing">${esc(ACCOUNT_WORDS[acc.state] || ACCOUNT_WORDS.unknown)}</span>`)
    + `</p><ul class="usage-list">${USAGE_LINES.map(([k, l]) => usageRow(l, w[k], k)).join('')}</ul>`;
  if (w.five_hour) html += `<p class="usage-five">5-hour window: ${esc(String(w.five_hour.pct))}% · Resets at ${esc(hm(w.five_hour.resetsAt))}</p>`;
  html += u.found ? (u.fetchedAt ? `<p class="hint">Read ${esc(ago(u.fetchedAt, now))}.</p>` : '') : `<p class="hint">No meter reading yet.</p>`;
  html += `</div>`;
  // P2-272 (P3 fixes, M3): only what the code backs. Watchkeeper's own count (orchestrator_usage.json, one UTC day) and the dated task
  // queue; no weekly Gemini figure exists, so there is no weekly % and no "Ready".
  const cut = t => { const x = String(t || ''); return x.length > 60 ? x.slice(0, 59) + '…' : x; };
  const week = Number.isFinite(g.weekTasks) && g.weekTasks >= 0 ? g.weekTasks : null;
  // a count for today means Watchkeeper counted, whatever the flag says
  const tracked = !!(g.tracked || g.today);
  let rows = '';
  if (tracked) {
    if (g.today) rows += `<li class="usage-row"><span class="usage-k">Today</span><span class="usage-v">${esc(plural(Number(g.today.requests) || 0, 'request'))} · ${esc(usd(Number(g.today.spendUsd) || 0))}</span></li>`;
    rows += `<li class="usage-row"><span class="usage-k">Cooldown</span><span class="usage-v">${g.cooldownUntil && g.cooldownUntil > now
      ? `Cooldown until ${esc(hm(g.cooldownUntil))}${g.cooldownReason ? ` (${esc(cut(g.cooldownReason))})` : ''}` : 'No cooldown on record'}</span></li>`;
  }
  if (week !== null) rows += `<li class="usage-row"><span class="usage-k">Last 7 days</span><span class="usage-v">${esc(plural(week, 'task'))} queued for Antigravity</span></li>`;
  html += `<div class="usage-block"><h3 class="usage-h">${esc(geminiLabelOf(g))}</h3>`
    + `<p class="hint">Watchkeeper's own count on this Mac, not Google's figure.</p>`
    + (tracked ? '' : `<p class="usage-missing">Nothing counted yet.</p>`)
    + (rows ? `<ul class="usage-list">${rows}</ul>` : '')
    + `</div></div>`;
  return html;
}

// The five-hour words come from the reading itself: slow fires at 75% and hold at 90%, so a fixed fraction would be wrong for one of them.
const REASONS = { ahead: 'used faster than the week has gone', ceiling: 'the hold line is reached', landed: 'the week has landed at its limit' };
function reasonWords(pace) {
  const r = pace && pace.reason;
  if (r === 'five_hour') return Number.isFinite(pace.fiveHour) ? `the five-hour window is ${pct(pace.fiveHour)} used` : 'the five-hour window is nearly used up';
  return REASONS[r] || String(r || '').replace(/_/g, ' ');
}

function status(m) {
  const p = m.pace || {};
  if (p.state === 'no-plugin') {   // sessions only: what any Claude Code user has
    const s = m.sessions || {};
    if (s.missing) return { key: 'unknown', word: 'Not set up', note: 'No Claude Code sessions folder was found.' };
    const act = (s.sessions || []).filter(x => x.active).length;
    return act ? { key: 'running', word: `${plural(act, 'session')} active`, note: 'Your Claude Code sessions on this computer.' }
      : { key: 'unknown', word: 'No session active', note: 'Your Claude Code sessions on this computer.' };
  }
  if (m.kill && m.kill.on) return { key: 'stopped', word: 'Stopped', note: 'The Stop switch is on: no wake-ups run.' };
  if (p.state === 'ok') {
    const d = p.pace.decision;
    if (d === 'hold') return { key: 'holding', word: 'Holding', note: `Pace says hold: ${reasonWords(p.pace)}.` };
    if (d === 'slow') return { key: 'holding', word: 'Holding back', note: `Pace says slow down: ${reasonWords(p.pace)}.` };
    return { key: 'running', word: 'Running', note: 'On pace; wake-ups may run.' };
  }
  if (p.state === 'no-meter') return { key: 'holding', word: 'Holding', note: 'No meter reading yet, so wake-ups wait.' };
  return { key: 'unknown', word: 'Unknown', note: 'The pace line could not be read.' };
}

function renderStatus(m) {
  const s = status(m);
  return `<p class="status status-${esc(s.key)}" role="status">${SHAPES[s.key] || ''}<span class="status-word">${esc(s.word)}</span></p><p class="status-note">${esc(s.note)}</p>`;
}

function paceSentence(p, now = Date.now()) {
  const bp = p.behindPoints, r = Math.round(Math.abs(Number(bp) || 0));
  const a = !Number.isFinite(bp) || r === 0 ? 'On the line' : bp < 0 ? `${plural(r, 'point')} ahead of the line` : `${plural(r, 'point')} behind the line`;
  const d = { run: 'running', slow: 'slowing down', hold: 'holding' }[p.decision] || 'no decision';
  let reset = '';
  const at = Date.parse(p.resetsAt);
  if (Number.isFinite(at)) {
    const h = Number.isFinite(p.hoursLeft) ? p.hoursLeft : (at - now) / 3600000;
    const inWords = h >= 1 ? `in ${plural(Math.floor(h), 'hour')}` : `in ${plural(Math.max(0, Math.round(h * 60)), 'minute')}`;
    reset = ` Reset ${when(at, now)}, ${inWords}.`;
  }
  return `${a}; ${d}.${reset}`;
}

function bar(used, gone, hold, land) {
  const c = x => Math.max(0, Math.min(100, x * 100)).toFixed(1);
  const label = `${pct(used)} used. Week gone ${pct(gone)}. Hold line ${pct(hold)}. Landing ${pct(land)}.`;
  return `<svg class="bar" viewBox="0 0 100 12" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">`
    + `<rect class="bar-track" x="0" y="2" width="100" height="8" rx="1"/>`
    + `<rect class="bar-fill" x="0" y="2" width="${c(used)}" height="8" rx="1"/>`
    + `<line class="mark mark-line" x1="${c(gone)}" x2="${c(gone)}" y1="0" y2="12"/>`
    + `<line class="mark mark-hold" x1="${c(hold)}" x2="${c(hold)}" y1="0" y2="12"/>`
    + `<line class="mark mark-land" x1="${c(land)}" x2="${c(land)}" y1="0" y2="12"/></svg>`
    + `<ul class="legend">`
    + `<li><svg class="glyph" viewBox="0 0 10 14" aria-hidden="true"><line class="mark mark-line" x1="5" x2="5" y1="0" y2="14"/></svg>Week gone <span class="num">${pct(gone)}</span></li>`
    + `<li><svg class="glyph" viewBox="0 0 10 14" aria-hidden="true"><line class="mark mark-hold" x1="5" x2="5" y1="0" y2="14"/></svg>Hold line <span class="num">${pct(hold)}</span></li>`
    + `<li><svg class="glyph" viewBox="0 0 10 14" aria-hidden="true"><line class="mark mark-land" x1="5" x2="5" y1="0" y2="14"/></svg>Landing <span class="num">${pct(land)}</span></li></ul>`;
}

function renderPace(m) {
  const r = m.pace || {}, now = m.now, home = m.paths && m.paths.home;
  const stopped = !!(m.kill && m.kill.on);
  const nextRead = stopped ? 'wake-ups are stopped now, so none will until you allow them again' : null;
  if (r.state === 'no-plugin') {
    return `<p class="empty">The Watchkeeper plugin was not found at <code>${esc(tilde(m.paths.pluginPath, home))}</code>.</p>`
      + `<p class="hint">Fix: in Settings, set <code>watchkeeper.pluginPath</code> to the folder that holds <code>bin/wk-ledger.mjs</code>.</p>`;
  }
  if (r.state === 'no-meter') {
    const extra = r.detail && r.detail !== 'no meter reading' ? `<p class="hint">Why: ${esc(r.detail)}.</p>` : '';
    const how = nextRead ? `A wake-up reads the plan's usage meter, but ${nextRead}.` : `The next wake-up reads the plan's usage meter, and it shows here.`;
    return `<p class="empty">No meter reading yet.</p><p class="hint">${esc(how)}</p>${extra}`;
  }
  if (r.state !== 'ok') return `<p class="empty">The pace line could not be read.</p><p class="hint">${esc(r.detail || '')}</p>`;
  const p = r.pace, used = Number(p.used) || 0, gone = Number(p.elapsed) || 0;
  const hold = Number.isFinite(p.reservePoints) ? 1 - p.reservePoints / 100 : 0.8;
  let html = `<p class="big"><span class="num big-num">${pct(used)}</span> <span class="big-label">of this week's plan used</span></p>`
    + bar(used, gone, hold, 0.98)
    + `<p class="sentence">${esc(paceSentence(p, now))}</p>`;
  if (p.reserveHeld && Number.isFinite(p.reservePoints) && Date.parse(p.reserveReleaseAt))
    html += `<p class="hint">${esc(plural(Math.round(p.reservePoints), 'point'))} held in reserve until ${esc(when(Date.parse(p.reserveReleaseAt), now))}.</p>`;
  if (Number.isFinite(p.fiveHour)) html += `<p class="hint">Five-hour window: <span class="num">${pct(p.fiveHour)}</span> used.</p>`;
  const age = Number(p.meterAgeMin);
  if (Number.isFinite(age)) {
    html += age > 360
      ? `<p class="warn">${SHAPES.unknown}The meter reading is ${esc(plural(Math.floor(age / 60), 'hour'))} old; ${esc(nextRead || 'the next wake-up reads a new one')}.</p>`
      : `<p class="hint">Meter read ${esc(age < 1 ? 'just now' : age < 60 ? `${Math.floor(age)} min ago` : `${Math.floor(age / 60)} h ago`)}.</p>`;
  }
  return html;
}

function renderSpend(m) {
  const l = m.ledger || {}, home = m.paths && m.paths.home;
  if (l.missing) return `<p class="empty">No spend recorded yet.</p><p class="hint">Each wake-up adds a line to <code>${esc(tilde(l.file || (m.paths.dataDir + '/ledger.jsonl'), home))}</code>.</p>`;
  const t = l.totals;
  let html = `<p class="big"><span class="num big-num">${esc(usd(t.usd))}</span> <span class="big-label">plan usage as US$ equivalent, ${esc(plural(t.runs, 'run'))}</span></p>`
    + `<dl class="grid"><div><dt>Tokens in</dt><dd class="num">${tok(t.in)}</dd></div><div><dt>Cache read</dt><dd class="num">${tok(t.cache_read)}</dd></div>`
    + `<div><dt>Cache write</dt><dd class="num">${tok(t.cache_write)}</dd></div><div><dt>Out</dt><dd class="num">${tok(t.out)}</dd></div></dl>`;
  if (l.top.length) {
    html += `<h3>Top items</h3><ol class="rows">` + l.top.map(r => `<li><span class="row-main">${esc(r.item)}</span><span class="row-meta"><span class="num">${esc(usd(r.usd))}</span>, ${esc(plural(r.runs, 'run'))}</span></li>`).join('') + `</ol>`;
  } else html += `<p class="hint">No runs in the last 7 days.</p>`;
  if (l.bad) html += `<p class="hint">${esc(plural(l.bad, 'line'))} could not be read and ${l.bad === 1 ? 'was' : 'were'} skipped.</p>`;
  return html;
}

function memberRow(x, now) {
  const model = [x.model, x.effort ? `${x.effort} effort` : ''].filter(Boolean).join(', ');
  const state = x.state === 'running' ? `running, last wrote ${ago(x.at, now)}` : x.state === 'stopped' ? `stopped without finishing, ${ago(x.at, now)}` : `done ${ago(x.at, now)}`;
  const shape = x.state === 'running' ? SHAPES.running : x.state === 'stopped' ? SHAPES.stopped : SHAPES.done;
  return `<li class="member member-${esc(x.state)}"><span class="role role-${esc(x.role.toLowerCase())}">${esc(x.role)}</span>`
    + `<span class="task">${esc(x.task)}</span><span class="row-meta">${shape}${esc([model, state].filter(Boolean).join(' · '))}</span></li>`;
}

// P2-223: Gemini sessions that stopped a turn in the last 10 minutes (the Antigravity plugin's Stop hook), only with the plugin.
function geminiCount(m) {
  const g = m.gemini;
  if (sessionsOnly(m) || !g || (!g.active && !(g.items || []).length)) return '';
  return `<p class="hint">Gemini in Antigravity: ${esc(plural(g.active, 'session'))} active in the last 10 minutes.</p>`;
}

function renderSessions(m, open = {}) {
  const s = m.sessions || {}, now = m.now, home = m.paths && m.paths.home;
  let html = '';
  if (s.missing) {
    html += `<p class="empty">No Claude sessions folder found.</p><p class="hint">Fix: in Settings, set <code>watchkeeper.claudeDir</code> to the folder that holds <code>projects/</code> (usually <code>~/.claude</code>).</p>${geminiCount(m)}`;
  } else if (!s.sessions.length) {
    html += `<p class="empty">No sessions in the last 24 hours.</p>${geminiCount(m)}`;
  } else {
    const act = s.sessions.filter(x => x.active).length;
    html += `<p class="hint">${esc(plural(s.sessions.length + s.more, 'session'))} in the last 24 hours; ${act} active now.</p>${geminiCount(m)}<ul class="sessions">`;
    for (const x of s.sessions) {
      const isOpen = x.id in open ? open[x.id] : x.active;
      const meta = [x.active ? 'Active' : 'Idle', x.project, ago(x.at, now), x.model, `transcript ~${tok(x.tokens)} tokens`].filter(Boolean).join(' · ');
      const shown = x.members.slice(0, 8), rest = x.members.length - shown.length;
      html += `<li class="session"><details data-id="${esc(x.id)}"${isOpen ? ' open' : ''}><summary><span class="s-title">${esc(x.title)}</span>`
        + `<span class="row-meta">${x.active ? SHAPES.running : SHAPES.unknown}${esc(meta)}</span></summary><ul class="members">`
        + `<li class="member"><span class="role role-main">Main</span><span class="task">This session</span><span class="row-meta">${esc([x.model, x.active ? 'active' : `last active ${ago(x.at, now)}`].filter(Boolean).join(' · '))}</span></li>`
        + shown.map(y => memberRow(y, now)).join('')
        + (rest > 0 ? `<li class="member more">and ${esc(plural(rest, 'more worker'))}</li>` : '')
        + (x.members.length ? '' : `<li class="member more">No workers in this session.</li>`)
        + `</ul></details></li>`;
    }
    html += `</ul>`;
    if (s.more) html += `<p class="hint">${esc(plural(s.more, 'older session'))} not shown.</p>`;
  }
  const w = (m.ledger && m.ledger.wakeups) || [];
  if (!sessionsOnly(m)) html += `<h3>Wake-ups</h3>` + (w.length ? `<ul class="rows">` + w.map(r => `<li><span class="row-main">${r.lens ? `${esc(r.lens)} lens` : esc(r.item)}</span>`
    + `<span class="row-meta">${esc([r.lens ? r.item : '', usd(r.usd), when(r.at, now), r.error ? 'ended with an error' : ''].filter(Boolean).join(' · '))}</span></li>`).join('') + `</ul>`
    : `<p class="hint">No wake-ups in the last 7 days.</p>`);
  const lk = m.locks || {};
  if (!lk.missing) {
    html += `<h3>Locked areas</h3>`;
    html += lk.locks.length ? `<ul class="rows">` + lk.locks.map(k => `<li><span class="row-main"><span class="area">${esc(k.area)}</span> ${k.item ? `<span class="item-id">${esc(k.item)}</span>` : ''}</span>`
      + `<span class="row-meta">${esc([k.label.replace(k.item, '').trim() || k.label, k.since ? `since ${lockSince(k.since, now)}` : ''].filter(Boolean).join(' · '))}</span></li>`).join('') + `</ul>`
      : `<p class="hint">No area is locked.</p>`;
  }
  return html;
}

function renderInbox(m) {
  const rows = m.inbox || [];
  if (!rows.length) return `<p class="hint">Nothing sent yet.</p>`;
  return `<ul class="rows inbox">` + rows.map(r => `<li><span class="row-meta"><span class="badge">${r.kind === 'rule' ? 'Rule change' : 'Recommendation'}</span> `
    + `${esc([r.status, r.at ? when(r.at, m.now) : ''].filter(Boolean).join(' · '))}</span><span class="row-main clamp">${esc(r.text)}</span></li>`).join('') + `</ul>`;
}

// P2-208: questions Gemini (or another agent) asked Claude, answered for the owner.
const ADVICE_WORDS = { asking: 'Answering now', answered: 'Answered', failed: 'Not answered', stopped: 'Stopped' };
function renderAdvice(m) {
  const a = m.ask || {}, adv = m.advice || { items: [], total: 0 }, now = m.now;
  let html = '';
  if (!a.installed) {
    html += `<p class="control-state">${SHAPES.unknown}Gemini cannot ask Claude yet.</p>`
      + (!isLocal(m) ? localLine() : a.commandOk ? `<button type="button" class="btn btn-secondary" data-cmd="installAsk">Let Gemini ask Claude</button>`
        + `<p class="hint">This adds the ask-claude skill to Antigravity (<code>~/.gemini/config/plugins/watchkeeper</code>). Claude then answers Gemini's questions the way you would, reading only.</p>`
        : `<p class="hint">The Watchkeeper plugin folder has no <code>bin/wk-ask-claude.mjs</code>. Check <code>watchkeeper.pluginPath</code> in Settings.</p>`);
  } else if (a.off) {
    html += `<p class="control-state">${SHAPES.stopped}The Watchkeeper plugin is switched off in Antigravity, so Gemini cannot ask.</p>`;
  } else {
    html += `<p class="hint">When Gemini needs your call, it asks Claude, who answers as you would (Fable, maximum effort, reading only). To overrule an answer, write a note below.</p>`;
  }
  if (!adv.items.length) return html + `<p class="hint">No questions yet.</p>`;
  html += `<ul class="rows advice">` + adv.items.map(x => {
    const meta = [x.from === 'gemini' ? 'Gemini' : x.from, x.at ? when(x.at, now) : '', x.cost != null ? usd(x.cost) : '', x.status === 'failed' && x.error ? x.error : ''].filter(Boolean).join(' · ');
    const open = !isLocal(m) ? '' : x.hasAnswer ? `<button type="button" class="btn btn-secondary btn-small" data-cmd="openAdvice" data-id="${esc(x.id)}" data-which="answer">Read the answer</button>`
      : `<button type="button" class="btn btn-secondary btn-small" data-cmd="openAdvice" data-id="${esc(x.id)}" data-which="question">Read the question</button>`;
    const shape = x.status === 'asking' ? SHAPES.running : x.status === 'answered' ? SHAPES.done : SHAPES.stopped;
    return `<li><span class="row-meta">${shape}<span class="badge">${esc(ADVICE_WORDS[x.status] || 'Not answered')}</span> ${esc(meta)}</span>`
      + `<span class="row-main clamp">${esc(x.preview)}</span><span class="row-action">${open}</span></li>`;
  }).join('') + `</ul>`;
  if (adv.total > adv.items.length) html += `<p class="hint">${esc(plural(adv.total - adv.items.length, 'older question'))} in <code>~/.wk/advice</code>.</p>`;
  return html;
}

function renderControls(m) {
  const k = m.kill || {}, f = esc(tilde(k.file, m.paths && m.paths.home));
  if (k.on) {
    return `<p class="control-state">${SHAPES.stopped}Wake-ups are stopped${k.at ? ` since ${esc(when(k.at, m.now))}` : ''}.</p>`
      + `<button type="button" class="btn" data-cmd="unkill">Allow wake-ups again</button>`
      + `<p class="hint">The Stop switch is on. Turning it off removes <code>${f}</code> after you confirm.</p>`;
  }
  return `<p class="control-state">${SHAPES.running}Wake-ups are allowed.</p>`
    + `<button type="button" class="btn btn-secondary" data-cmd="kill">Stop all wake-ups</button>`
    + `<p class="hint">The Stop switch creates <code>${f}</code>. While it exists, Claude sessions using the Watchkeeper plugin can only read: no writing, shell, web or MCP tools.</p>`;
}

// Updates (P2-209): the last wk-update check on this computer, or how to set the checks up.
function renderUpdate(m) {
  const u = m.update || {}, l = u.last, home = m.paths && m.paths.home;
  const name = u.version ? `Watchkeeper ${esc(u.version)}` : 'Watchkeeper';
  const route = u.route || { kind: 'other' };
  if (!l && route.kind === 'clone') {
    const cmd = `node ${esc(tilde((m.paths && m.paths.pluginPath) || '', home))}/bin/wk-update.mjs install`;
    return `<p class="control-state">${name}.</p><p class="hint">Automatic updates are not set up on this computer. To set them up, run <code>${cmd}</code> in Terminal once.</p>`;
  }
  // installed through Claude Code: wk-update is not for this copy (the folder changes with every update)
  if (!l && route.kind === 'marketplace') {
    const mk = esc(route.marketplace), pl = esc(route.plugin);
    return `<p class="control-state">${name}.</p><p class="hint">Claude Code updates this plugin by itself only if auto-update is on for the <code>${mk}</code> marketplace (in <code>/plugin</code>). To update by hand, run <code>claude plugin marketplace update ${mk}</code>, then <code>claude plugin update ${pl}@${mk}</code>.</p>`;
  }
  if (!l) return `<p class="control-state">${name}.</p><p class="hint">This copy is not a git clone, so it cannot update itself. Install the plugin through Claude Code, or use a git clone, to get updates.</p>`;
  const at = l.at ? ` (checked ${esc(when(l.at, m.now))})` : '';
  // why the W panel and Gemini's skill were left as they are (the folder is not exactly on the newest release)
  const held = l.held ? `<p class="hint">The W panel and Gemini's skill were left as they are: ${esc(l.held)}.</p>` : '';
  if (l.result === 'problem') return `<p class="warn">${SHAPES.unknown}${name} was not updated${at}.</p>${l.problem ? `<p class="hint">Why: ${esc(l.problem)}.</p>` : ''}${held}`;
  if (l.result === 'paused') return `<p class="control-state">${SHAPES.stopped}Update checks are paused while wake-ups are stopped${at}.</p>`;
  const what = l.result === 'updated' && l.moved && l.moved.from ? `updated from ${esc(l.moved.from)}` : l.result === 'skipped' ? 'check skipped, the next one retries' : 'up to date';
  const old = l.at && m.now - l.at > 24 * 3600 * 1000
    ? `<p class="warn">${SHAPES.unknown}The last check was ${esc(ago(l.at, m.now))}. Checks run every 3 hours while this computer is awake.</p>` : '';
  return `<p class="control-state">${SHAPES.running}${name}: ${what}${at}.</p>${held}${old}`;
}

// P2-272 (P3-C): Updates and Messages from the developer's signed channel (panel/src/channel.js). Only verified items
// arrive here; every field is plain text, escaped; the contact address comes only from the signed news.json.
// The Updates section's signed line: a newer release the developer signed, with its notes.
function renderChannelUpdate(m) {
  const c = m.channel;
  if (!c || !c.updateAvailable || !c.version) return '';
  return `<p class="control-state">${SHAPES.running}A signed update is out: Watchkeeper ${esc(c.version)}.</p>`
    + (c.notes ? `<p class="hint channel-body">${esc(c.notes)}</p>` : '');
}
function renderChannel(m) {
  const c = m.channel;
  if (!c || typeof c !== 'object') return '<p class="empty">No messages yet.</p>';
  let html = '';
  const items = arr(c.items);
  if (items.length) html += `<ul class="rows channel-items">` + items.map(it => `<li class="channel-item">`
    + `<span class="row-main"><strong>${esc(it.title)}</strong></span>`
    + `<span class="row-meta">${esc(it.date)} · ${esc(it.kind)}</span>`
    + `<p class="channel-body">${esc(it.body)}</p>`
    + (typeof it.link === 'string' && /^https:\/\//.test(it.link) ? `<p class="hint"><a href="${esc(it.link)}" rel="noopener noreferrer">${esc(it.link)}</a></p>` : '')
    + `</li>`).join('') + `</ul>`;
  else html += '<p class="empty">No messages yet.</p>';
  if (typeof c.contact === 'string' && c.contact) html += `<p class="hint">Contact the developer: <a href="mailto:${esc(c.contact)}">${esc(c.contact)}</a></p>`;
  if (c.hint) html += `<p class="hint">${SHAPES.unknown}${esc(c.hint)}</p>`;
  else if (c.error) html += `<p class="hint">${SHAPES.unknown}Messages: ${esc(c.error)}.</p>`;
  return html;
}

// ---------------------------------------------------------------- P2-223: "Waiting for you"
const SHOWN = 5;
const FROM_WORDS = { claude: 'Claude', gemini: 'Gemini', watchkeeper: 'Watchkeeper', owner: 'you', unknown: 'an agent' };
const MONEY_NOTE = 'About money, legal wording or an account. Press OK again to confirm.';
// About 280 characters, cut at a space; the rest waits behind "More".
function expandable(text, key, n = 280) {
  const t = String(text || '');
  if (t.length <= n + 40) return esc(t);
  let cut = t.lastIndexOf(' ', n); if (cut < n * 0.6) cut = n;
  return `${esc(t.slice(0, cut))}<span class="ell" aria-hidden="true">…</span><span class="more-rest" hidden>${esc(t.slice(cut))}</span> `
    + `<button type="button" class="link-btn" data-cmd="more" data-key="${esc(key)}" aria-expanded="false">More</button>`;
}

function questionRow(x, extra) {
  const n = esc(x.n), meta = [`Q${x.n}`, x.from ? `from ${x.from}` : '', x.date].filter(Boolean).join(' · ');
  return `<li class="wait${extra ? ' wait-extra' : ''}" data-q="${n}"${extra ? ' hidden' : ''}>`
    + `<span class="row-meta"><span class="badge">Question</span> ${esc(meta)}</span>`
    + `<p class="wait-text">${expandable(x.text, 'q' + x.n)}</p>`
    + (x.rec ? `<p class="wait-rec"><span class="rec-label">Recommended:</span> ${esc(x.rec)}</p>` : '')
    + `<div class="actions">`
    + (x.rec ? `<button type="button" class="btn btn-small" data-cmd="okQuestion" data-n="${n}"${x.money ? ' data-money="1"' : ''} aria-label="OK: send the recommended answer to Q${n}">OK</button>` : '')
    + `<button type="button" class="btn btn-secondary btn-small" data-cmd="openAnswer" data-n="${n}" aria-expanded="false" aria-controls="ans-${n}">Answer…</button>`
    + `<button type="button" class="btn btn-secondary btn-small" data-cmd="laterQuestion" data-n="${n}" aria-label="Later: hide Q${n} for 24 hours">Later</button></div>`
    + (x.money ? `<p class="confirm-note" data-confirm="q${n}" hidden>${esc(MONEY_NOTE)}</p>` : '')
    + `<div class="answer-box" id="ans-${n}" hidden><label class="label" for="ans-text-${n}">Your answer to Q${n}</label>`
    + `<textarea id="ans-text-${n}" rows="3" maxlength="${D.MAX_TEXT}" data-answer="${n}"></textarea>`
    + `<div class="actions"><button type="button" class="btn btn-small" data-cmd="sendAnswer" data-n="${n}">Send</button>`
    + `<button type="button" class="btn btn-secondary btn-small" data-cmd="cancelAnswer" data-n="${n}">Cancel</button></div></div></li>`;
}

function suggestionRow(x, extra, now, local = true) {
  const id = esc(x.id), meta = [`from ${FROM_WORDS[x.from] || 'an agent'}`, x.at ? when(x.at, now) : ''].filter(Boolean).join(' · ');
  const b = (choice, label, cls) => `<button type="button" class="btn btn-small${cls}" data-cmd="decide" data-id="${id}" data-choice="${choice}"${choice === 'ok' && x.money ? ' data-money="1"' : ''}${choice === 'ok' && x.action === 'task-merge' ? ' data-merge="1"' : ''}>${label}</button>`;
  return `<li class="wait${extra ? ' wait-extra' : ''}" data-s="${id}"${extra ? ' hidden' : ''}>`
    + `<span class="row-meta"><span class="badge">${x.action === 'task-merge' ? 'Change ready' : 'Suggestion'}</span> ${esc(meta)}</span>`
    + `<p class="wait-title">${esc(x.title)}</p>`
    + (x.detail ? `<p class="wait-text wait-detail">${expandable(x.detail, 's' + x.id)}</p>` : '')
    + `<div class="actions">${b('ok', 'OK, go ahead', '')}${b('later', 'Not now', ' btn-secondary')}${b('no', 'No', ' btn-secondary')}`
    + (local && x.action === 'task-merge' && x.hasDiff ? `<button type="button" class="btn btn-secondary btn-small" data-cmd="openTaskDiff" data-id="${esc(x.ref)}">Show the change</button>` : '')
    + `</div>` + (!local && x.action === 'task-merge' && x.hasDiff ? localLine('To see the change: ') : '') + (x.money ? `<p class="confirm-note" data-confirm="s${id}" hidden>${esc(MONEY_NOTE)}</p>` : '') + `</li>`;
}

// P2-272: a worktree the watchdog wants to remove. The owner decides; the result of the command shows directly under the row.
function removalRow(x, now) {
  const id = esc(x.task_id), name = esc(x.worktree || x.task_id);
  const msg = `<p class="wait-msg${x.ok === false ? ' wait-msg-error' : ''}" data-removal-msg="${id}" aria-live="polite">${esc(x.message || '')}</p>`;
  if (x.done) return `<li class="wait" data-r="${id}"><p class="wait-title">${name}</p>${msg}</li>`;
  const why = x.dirty
    ? `Quiet${x.last_output_at ? ` since ${esc(when(Date.parse(x.last_output_at) || x.last_output_at, now))}` : ''}, with changes that are not saved (dirty). Removing it keeps a backup first.`
    : `Quiet${x.last_output_at ? ` since ${esc(when(Date.parse(x.last_output_at) || x.last_output_at, now))}` : ''}, with nothing unsaved (clean).`;
  const b = (choice, label, cls) => `<button type="button" class="btn btn-small${cls}" data-cmd="removal" data-id="${id}" data-choice="${choice}">${label}</button>`;
  return `<li class="wait" data-r="${id}"><span class="row-meta"><span class="badge">Remove worktree?</span></span>`
    + `<p class="wait-title">${name}</p><p class="wait-text">${why}</p>`
    + `<div class="actions">${b('ok', 'OK, go ahead', '')}${b('later', 'Not now', ' btn-secondary')}${b('no', 'No', ' btn-secondary')}</div>${msg}</li>`;
}

function renderWaiting(m) {
  const q = m.questions || { items: [], hidden: 0 }, s = m.suggestions || { items: [] }, now = m.now;
  const qs = q.items || [], ss = s.items || [], rs = Array.isArray(m.removals) ? m.removals : [];
  const removalList = rs.length ? `<h3>Worktrees <span class="num count-n">${rs.filter(x => !x.done).length}</span></h3><ul class="rows waiting" data-list="r">${rs.map(x => removalRow(x, now)).join('')}</ul>` : '';
  const hiddenNote = q.hidden ? `<p class="hint">${esc(plural(q.hidden, 'question'))} hidden for 24 hours with Later.</p>` : '';
  if (!qs.length && !ss.length && !rs.length) return `<p class="empty">Nothing waits for you.</p>${hiddenNote}`;
  const list = (key, word, rows, row) => `<h3>${word} <span class="num count-n">${rows.length}</span></h3><ul class="rows waiting" data-list="${key}">`
    + rows.map((x, i) => row(x, i >= SHOWN)).join('') + `</ul>`
    + (rows.length > SHOWN ? `<button type="button" class="btn btn-secondary btn-small" data-cmd="showAll" data-list="${key}" aria-expanded="false">Show all ${rows.length}</button>` : '');
  return (qs.length ? list('q', 'Questions', qs, questionRow) : '') + hiddenNote
    + (ss.length ? list('s', 'Suggestions', ss, (x, extra) => suggestionRow(x, extra, now, isLocal(m))) : '') + removalList;
}

// ---------------------------------------------------------------- P2-223: Gemini
const KIND_WORDS = { read: 'Read', quick: 'Quick', code: 'Code', ui: 'Screens', plan: 'Plan', hard: 'Hard', review: 'Review', legal: 'Legal' };
const KIND_FOR = {
  read: 'read, search and summarize, no edits', quick: 'small, clear jobs: renames, docs, small scripts, tests', code: 'a feature or fix in one area',
  ui: 'screens, layout and styles', plan: 'features across many files, refactors', hard: 'hard bugs, concurrency, migrations, architecture', review: 'a second opinion on a change, read-only',
  legal: 'legal wording, on the strongest model; the owner approves it before use'
};
const TASK_WORDS = {
  queued: 'Waiting for Gemini', taken: 'Gemini is on it', verified: 'Checked: tests pass', failed: 'Checks failed', 'out-of-scope': 'Changed files outside its list',
  'no-change': 'No change made', merged: 'Merged', discarded: 'Set aside', conflict: 'Merge conflict: nothing merged', unknown: 'Unknown'
};
const TASK_SHAPE = { queued: 'unknown', taken: 'running', verified: 'done', merged: 'done', failed: 'stopped', 'out-of-scope': 'stopped', conflict: 'stopped', 'no-change': 'unknown', discarded: 'unknown', unknown: 'unknown' };
const DIFF_STATES = ['verified', 'failed', 'out-of-scope', 'conflict'];

function renderGemini(m) {
  const t = m.tasks || { items: [], total: 0 }, g = m.gemini || { items: [] }, now = m.now, home = m.paths && m.paths.home;
  let html = `<h3>Queue</h3>`;
  if (!t.items.length) html += `<p class="hint">No tasks yet. Hand one to Gemini below.</p>`;
  else {
    html += `<ul class="rows tasks">` + t.items.map(x => {
      const meta = [x.kind ? KIND_WORDS[x.kind] : '', x.model ? `suggested ${x.model}` : '', x.modelUsed ? `used ${x.modelUsed}` : '', ago(x.takenAt && x.status === 'taken' ? x.takenAt : x.at, now)].filter(Boolean).join(' · ');
      return `<li><span class="row-main task-title">${esc(x.title)}</span>`
        + `<span class="row-meta">${SHAPES[TASK_SHAPE[x.status] || 'unknown']}<span class="badge">${esc(x.status === 'verified' && x.hasTest === false ? 'Checked: files only, no test set' : TASK_WORDS[x.status] || 'Unknown')}</span>${x.held ? ' <span class="bridge-chip tone-amber held-chip" title="On hold: the checker never requeues it. wk-task release lifts it.">held</span>' : ''} ${esc(meta)}</span>`
        + (x.note ? `<span class="row-meta clamp">${esc(x.note)}</span>` : '')
        + (x.status === 'queued' && isLocal(m) ? `<span class="row-action"><button type="button" class="btn btn-small" data-cmd="chatTakeTask" data-task-id="${esc(x.id)}">Take in Watchkeeper →</button></span>` : '')
        + (DIFF_STATES.includes(x.status) && x.hasDiff && isLocal(m) ? `<span class="row-action"><button type="button" class="btn btn-secondary btn-small" data-cmd="openTaskDiff" data-id="${esc(x.id)}">Show the change</button></span>` : '')
        + `</li>`;
    }).join('') + `</ul>`;
    if (t.total > t.items.length) html += `<p class="hint">${esc(plural(t.total - t.items.length, 'older task'))} in <code>${esc(tilde((m.paths && m.paths.dataDir) || '~/.wk', home))}/tasks</code>.</p>`;
  }
  html += `<h3>Last Gemini sessions</h3>`;
  html += g.items.length ? `<ul class="rows">` + g.items.map(r => `<li><span class="row-main">${esc(r.model || 'Model not recorded')}</span>`
    + `<span class="row-meta">${esc([r.folder, when(r.at, now)].filter(Boolean).join(' · '))}</span></li>`).join('') + `</ul>`
    : `<p class="hint">No Gemini sessions recorded yet. The Watchkeeper plugin in Antigravity notes each one when it stops.</p>`;
  return html;
}

// What happens at each Gemini step on this machine: the installer's per-machine pass decision (~/.wk/antigravity-hook.json).
const HOOK_WORDS = {
  allow: "Gemini's steps run without asking you (your Turbo setting). In Watchkeeper's own tasks it still blocks secrets, pushes, and every step while the stop switch is on.",
  ask: "Antigravity asks you before Gemini's steps. Hourly runs can't do those steps.",
  unknown: 'Install Watchkeeper into Antigravity to set this.'
};
function hookPassLine(m) {
  const p = m.hookPass && m.hookPass.pass;
  return `<p class="hint hook-pass">${esc(HOOK_WORDS[p] || HOOK_WORDS.unknown)}</p>`;
}

// The kinds and the model each suggests (config/gemini.json); without the file, the kinds alone.
function renderRoutes(m) {
  const c = m.geminiConfig || { found: false, routes: {} };
  const rows = D.TASK_KINDS.map(k => {
    const r = c.routes && c.routes[k];
    return `<li><span class="row-main"><span class="area">${esc(KIND_WORDS[k])}</span>${r && r.model ? ` <span class="num">${esc(r.model)}</span>` : ''}</span>`
      + `<span class="row-meta">${esc([r && r.for ? r.for : KIND_FOR[k], r && r.fallback ? `if your plan lacks it: ${r.fallback}` : ''].filter(Boolean).join(' · '))}</span></li>`;
  }).join('');
  return `<details class="routes" data-id="wk-routes"><summary>Which model each kind suggests</summary><ul class="rows">${rows}</ul>`
    + (c.found ? '' : `<p class="hint">No model table yet: the plugin's <code>config/gemini.json</code> is missing.</p>`)
    + `<p class="hint">In Antigravity you pick the model in the model menu, or in the automation; a plugin cannot set it. So the queue shows the suggested model and the one the session reported.</p></details>` + hookPassLine(m);
}

// ---------------------------------------------------------------- P2-227: jobs, projects and the phone
const JOB_WORDS = { queued: 'Waiting to start', running: 'Running', waiting: 'Waiting for your reply', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
const JOB_SHAPE = { queued: 'unknown', running: 'running', waiting: 'holding', done: 'done', failed: 'stopped', stopped: 'stopped' };
const MODEL_WORDS = { sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable', haiku: 'Haiku' };
const FROM_JOB = { phone: 'from the phone', panel: 'from the panel', cli: 'from the Mac' };
const cut = (v, n) => { const t = String(v == null ? '' : v); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// One line of a job's output, as plain text (the web page draws the same words with textContent).
function eventLine(ev) {
  if (!ev || typeof ev !== 'object') return '';
  switch (ev.type) {
    case 'init': return `Started (${cut(ev.model, 40)}${ev.permissionMode ? `, ${cut(ev.permissionMode, 40)}` : ''}).`;
    case 'text': return cut(ev.text, 4000);
    case 'tool': return `Tool: ${cut(ev.name, 80)}${ev.short ? ` ${cut(ev.short, 200)}` : ''}`;
    case 'permission_denied': return `Not allowed: ${cut(ev.tool, 80)}`;
    case 'result': return `Finished (${cut(ev.subtype, 40)}${typeof ev.cost_usd === 'number' ? `, ${usd(ev.cost_usd)}` : ''}${typeof ev.turns === 'number' ? `, ${plural(ev.turns, 'turn')}` : ''})${ev.text ? `: ${cut(ev.text, 8000)}` : '.'}`;
    default: return ev.text ? cut(ev.text, 4000) : '';
  }
}
const arr = v => (Array.isArray(v) ? v : []);

function jobForm(m) {
  const ps = arr(m.projects), r = m.remote || {};
  if (!ps.length) {
    return `<p class="empty">No projects to start a job in yet.</p>`
      + (isLocal(m) ? `<p class="hint">Make the list once: in the Watchkeeper folder run <code>node bin/wk-projects.mjs scan</code>.</p>`
        : `<p class="hint">On the Mac, run <code>node bin/wk-projects.mjs scan</code> in the Watchkeeper folder once.</p>`);
  }
  const hours = Number.isFinite(r.job_hours) ? r.job_hours : 3;
  return `<div class="job-form" data-form="jobStart"><h3>Start a job</h3>`
    + `<label class="label" for="job-project">Project</label><select id="job-project" name="project">`
    + ps.map(p => `<option value="${esc(p.key)}">${esc(p.name || p.key)}</option>`).join('') + `</select>`
    + `<label class="label" for="job-prompt">What to do</label><textarea id="job-prompt" name="prompt" rows="4" maxlength="${D.MAX_PROMPT}"></textarea>`
    + `<label class="label" for="job-model">Model</label><select id="job-model" name="model">`
    + D.MODELS.map(x => `<option value="${esc(x)}"${x === 'sonnet' ? ' selected' : ''}>${esc(MODEL_WORDS[x] || x)}</option>`).join('') + `</select>`
    + `<label class="label" for="job-mode">How</label><select id="job-mode" name="mode">`
    + D.MODES.map(x => `<option value="${esc(x)}"${x === 'auto' ? ' selected' : ''}>${esc(D.MODE_WORDS[x])}</option>`).join('') + `</select>`
    + `<label class="label" for="job-turns">Turns at most</label><input id="job-turns" name="max_turns" type="number" inputmode="numeric" min="1" max="400" value="150">`
    + `<div class="actions"><button type="button" class="btn" data-cmd="jobStart">Start the job</button></div>`
    + `<p class="hint">The job runs on the Mac with Claude Code in the project's folder, follows its CLAUDE.md, and stops after ${esc(plural(hours, 'hour'))}.`
    + `${isLocal(m) ? '' : ' Starting a job asks for your passkey each time.'}</p></div>`;
}
function renderJobs(m) {
  const js = arr(m.jobs), now = m.now, local = isLocal(m);
  const wd = m.watchdog;
  let alertHtml = '';
  if (wd && (wd.hungCount > 0 || wd.warningCount > 0)) {
    const flagged = arr(wd.items).filter(it => it && (it.classification === 'hung' || it.classification === 'warning')).slice(0, 4);
    alertHtml = `<div class="wk-watchdog-alert" role="status">`
      + `<strong>Watchdog:</strong> ${esc(String(wd.hungCount || 0))} hung · ${esc(String(wd.warningCount || 0))} warning`
      + (flagged.length
        ? `<ul class="rows">` + flagged.map(it => `<li><span class="row-main">${esc(it.surface || 'task')}: ${esc(it.title || it.id || '')}</span> <span class="row-meta">${esc(it.classification)} · ${esc(it.reason || '')}</span></li>`).join('') + `</ul>`
        : '')
      + (local
        ? `<div class="actions"><button type="button" class="btn secondary" data-cmd="watchdogScan">Scan now</button>${Number(wd.hungCount || 0) > 0 ? '<button type="button" class="btn" data-cmd="watchdogRecover">Recover hung</button>' : ''}</div>`
        : '')
      + `</div>`;
  }
  let html = alertHtml + jobForm(m);
  if (!js.length) return html + `<p class="hint">No jobs yet.</p>`;
  html += `<h3>Jobs</h3><ul class="rows jobs">` + js.map(j => {
    const id = esc(j.id), st = JOB_WORDS[j.state] ? j.state : 'failed';
    const badge = j.carbon_fallback
      ? `<span class="badge badge-accent">Queued for Antigravity</span> `
      : '';
    const modelWord = j.carbon_fallback
      ? `Antigravity queue ${j.model_id || ''}`.trim()
      : (j.legal ? D.legalLabel(j.model_id) : MODEL_WORDS[j.model] || j.model);
    const meta = [j.project, modelWord, D.MODE_WORDS[j.mode] || '', FROM_JOB[j.from] || '', j.started_at ? when(j.started_at, now) : '',
    typeof j.cost_usd === 'number' ? usd(j.cost_usd) : '', typeof j.turns === 'number' ? plural(j.turns, 'turn') : ''].filter(Boolean).join(' · ');
    const tail = local ? arr(j.tail).map(ev => { const t = eventLine(ev); return t ? `<li class="ev ev-${esc(String(ev.type || 'x').replace(/[^a-z_]/g, ''))}">${esc(t)}</li>` : ''; }).join('') : '';
    return `<li class="job" data-job-item="${id}"><details data-job="${id}" data-id="job-${id}">`
      + `<summary>${SHAPES[JOB_SHAPE[st]]}${badge}<span class="badge">${esc(JOB_WORDS[st])}</span> <span class="job-title">${esc(j.title || j.id)}</span></summary>`
      + `<span class="row-meta">${esc(meta)}</span>`
      + (j.last_text ? `<p class="wait-text job-last">${esc(j.last_text)}</p>` : '')
      + `<ol class="job-out" data-job-out="${id}" aria-label="Output of job ${id}">${tail}</ol>`
      + (st === 'waiting' ? `<label class="label" for="reply-${id}">Your reply</label><textarea id="reply-${id}" rows="3" maxlength="${D.MAX_PROMPT}" data-reply="${id}"></textarea>`
        + `<div class="actions"><button type="button" class="btn btn-small" data-cmd="jobReply" data-job="${id}">Send the reply</button></div>` : '')
      + (st === 'running' || st === 'queued' ? `<div class="actions"><button type="button" class="btn btn-secondary btn-small" data-cmd="jobStop" data-job="${id}">Stop</button></div>` : '')
      + `</details></li>`;
  }).join('') + `</ul>`;
  return html;
}

function renderProjects(m) {
  const ps = arr(m.projects), f = m.projectsFile || {}, now = m.now;
  if (!ps.length) {
    return `<p class="empty">No projects listed yet.</p>`
      + (f.found ? '' : `<p class="hint">Watchkeeper lists the git repositories under <code>~/Projects</code> and <code>~/Developer</code> when you run <code>node bin/wk-projects.mjs scan</code> on the Mac.</p>`);
  }
  let html = `<ul class="rows projects">` + ps.map(p => {
    const c = p.last || null;
    const sync = [p.ahead ? `${p.ahead} ahead` : '', p.behind ? `${p.behind} behind` : ''].filter(Boolean).join(', ');
    const meta = [p.branch, p.changed ? plural(p.changed, 'changed file') : p.changed === 0 ? 'clean' : '', sync, p.git === false ? 'not a git repository' : ''].filter(Boolean).join(' · ');
    const live = [p.sessions ? plural(p.sessions, 'session') : '', p.jobs ? plural(p.jobs, 'job') : '', p.gemini ? plural(p.gemini, 'Gemini task') : ''].filter(Boolean).join(' · ');
    const items = arr(p.items);
    return `<li><span class="row-main"><span class="area">${esc(p.name || p.key)}</span> <span class="row-meta">${esc(p.path || '')}</span></span>`
      + (meta ? `<span class="row-meta">${esc(meta)}</span>` : '')
      + (c ? `<span class="row-meta clamp"><span class="num">${esc(c.sha7)}</span> ${esc(c.subject)}${c.at ? ` · ${esc(ago(c.at, now))}` : ''}</span>` : '')
      + (live ? `<span class="row-meta">${SHAPES.running}${esc(live)}</span>` : '')
      + (items.length ? `<span class="row-meta clamp">Open: ${esc(items.map(i => i.id).join(', '))}</span>` : '')
      + `</li>`;
  }).join('') + `</ul>`;
  if (f.more) html += `<p class="hint">${esc(plural(f.more, 'more project'))} in <code>~/.wk/projects.json</code> (the first 40 show).</p>`;
  return html;
}

function renderPhone(m) {
  const ph = m.phone || {}, now = m.now, local = isLocal(m), trusted = arr(ph.trusted), pending = arr(ph.pending);
  const short = id => String(id).slice(0, 8);
  let html = ph.enabled ? `<p class="control-state">${SHAPES.running}Phone control is on.</p>`
    : `<p class="control-state">${SHAPES.stopped}Phone control is off. The Mac acts on nothing from the phone.</p>`;
  const noServer = local && !ph.enabled && !ph.origin;
  if (noServer) html += `<p class="hint">Phone control needs a companion server, which is not published yet. If you run one, set it with <code>node &lt;plugin&gt;/bin/wk-remote.mjs config</code>; the switch shows here after that.</p>`;
  else if (local) {
    html += ph.enabled ? `<button type="button" class="btn btn-secondary" data-cmd="remoteOff">Switch phone control off</button>`
      : `<button type="button" class="btn btn-secondary" data-cmd="remoteOn">Switch phone control on</button>`
      + `<p class="hint">Only phone keys you trusted here can send commands. Answers and decisions need Face ID every 10 minutes; a new job or a reply needs it each time.</p>`;
  } else if (!ph.enabled) html += localLine('To switch it on: ');
  if (pending.length) {
    html += `<h3>Waiting for Trust</h3><ul class="rows phone-keys">` + pending.map(k => `<li><span class="row-main">${esc(k.label)} <span class="num">${esc(short(k.id))}</span></span>`
      + `<span class="row-meta">${esc(k.registered_at ? `set up ${when(k.registered_at, now)}` : 'set up on the phone')}</span>`
      + (local ? `<span class="row-action"><button type="button" class="btn btn-small" data-cmd="trustKey" data-id="${esc(k.id)}">Trust</button>`
        + `<button type="button" class="btn btn-secondary btn-small" data-cmd="rejectKey" data-id="${esc(k.id)}">Reject</button></span>` : '')
      + `</li>`).join('') + `</ul>`
      + (local ? `<p class="hint">Trust a key only if you set it up on your own phone just now and the short code matches the one the phone shows.</p>` : localLine('To trust a key: '));
  }
  html += `<h3>Trusted phone keys</h3>` + (trusted.length ? `<ul class="rows phone-keys">` + trusted.map(k => `<li><span class="row-main">${esc(k.label)} <span class="num">${esc(short(k.id))}</span></span>`
    + `<span class="row-meta">${esc(k.added_at ? `trusted ${when(k.added_at, now)}` : 'trusted')}</span></li>`).join('') + `</ul>`
    : `<p class="hint">None yet.${noServer ? '' : local ? ' Set up the phone on your server first, then press Trust here.' : ''}</p>`);
  return html;
}

// The one status line from bin/wk-status.mjs --json, with a plain fallback (the panel's bar and the phone page share it).
const STATUS_FALLBACK = { stopped: 'Stopped: the Stop switch is on.', error: 'The status line could not be read.' };
const statusLineText = m => (typeof m.statusLine === 'string' && m.statusLine.trim() ? m.statusLine.trim() : (STATUS_FALLBACK[m.statusState] || 'Reading…'));

// The web host's status: the Mac's status line, the Mac, the stop switch and the limits, in one place
function webStatus(m) {
  const mac = m.mac || {}, r = m.remote || {};
  const macLine = mac.name ? `<p class="hint">${esc(mac.name)}${typeof mac.free_mb === 'number' ? ` · ${esc(mac.free_mb.toLocaleString('en-GB'))} MB free` : ''}${mac.low_ram ? ' · low on memory: new jobs wait' : ''}</p>` : '';
  const limits = Number.isFinite(r.max_jobs) ? `<p class="hint">At most ${esc(plural(r.max_jobs, 'job'))} at once, each up to ${esc(plural(r.job_hours, 'hour'))}; new jobs wait when the week's use reaches ${esc(r.pace_stop_pct)}%.</p>` : '';
  const line = sessionsOnly(m) ? '' : `<p class="wk-status-line">${esc(statusLineText(m))}</p>`;
  return renderStatus(m) + line + macLine + renderControls(m) + limits;
}
function renderAboutWeb(m) {
  const b = m.bridge || {};
  return `<p class="hint">This page shows what Watchkeeper on your Mac sent${b.pushed_at ? ` (last at ${esc(when(b.pushed_at, m.now))})` : ''}. The Mac checks every press: it acts only on commands signed with a phone key you trusted on the Mac, and only while phone control is on.</p>`
    + `<p class="hint">No code comes from this page to the Mac, and no file goes from the Mac without a scan for secrets first.${b.version ? ` Watchkeeper ${esc(b.version)}.` : ''}</p>`;
}

// Without the Watchkeeper plugin the panel shows only what works for any Claude Code user; the plugin's sections stay hidden.
// S5: what the panel itself writes, said once in the drawer and in the README.
const PANEL_WRITES = 'With the plugin, in a trusted folder and while the Stop switch is off, the panel moves finished or old Watchkeeper chat sessions into ~/.wk/chat-sessions/archive/ and, once an hour, ~/.wk/hook_sessions files older than 7 days into its archive folder. Nothing else here writes unless you press a button.';
const sessionsOnly = m => !!(m.pace && m.pace.state === 'no-plugin');
function renderAbout(m) {
  const home = m.paths && m.paths.home, c = esc(tilde((m.paths && m.paths.claudeDir) || '~/.claude', home));
  return `<p class="hint">This panel reads the Claude Code session files in <code>${c}/projects</code> on this computer and checks whether the Watchkeeper plugin is set up. It makes no network calls and writes nothing. With the plugin installed, in a trusted folder and while the Stop switch is off, it also moves finished or old Watchkeeper chat sessions into <code>~/.wk/chat-sessions/archive/</code> and old <code>~/.wk/hook_sessions</code> files into their archive folder.</p>`
    + `<p class="hint">A session is active when it wrote in the last 10 minutes. A worker is a sub-agent that a session started. The token count is an estimate of the transcript's length, not of what the session used.</p>`
    + `<p class="hint">Install the free Watchkeeper plugin for Claude Code to add questions and suggestions with one-press answers, jobs you start from here, spend, the Gemini queue and a switch that stops unattended work. In Claude Code, type: <code>/plugin install watchkeeper --marketplace tengotengo23/nexodyne-watchkeeper</code> (before Claude Code 2.1.275, two lines: <code>/plugin marketplace add tengotengo23/nexodyne-watchkeeper</code> and <code>/plugin install watchkeeper@nexodyne</code>). The panel then finds the plugin by itself; set <code>watchkeeper.pluginPath</code> in Settings only for a copy kept somewhere else.</p>`;
}

function renderOrchestrator(m) {
  const c = m.carbon || {}, p = m.pace || {};
  const exhausted = Boolean(c.claudeExhausted);
  const shape = exhausted ? SHAPES.running : SHAPES.done;
  const headline = exhausted
    ? 'Claude Code limits reached on Watchkeeper\'s meter. Gemini runs here only with a Gemini API key added in Settings; otherwise the work is queued for Antigravity (wk-task), which takes it when you run /wk-take-task there.'
    : 'Claude Code has room on Watchkeeper\'s meter. Auto picks Claude or Gemini by quota and task size. Gemini runs here only with a Gemini API key added in Settings; otherwise the work is queued for Antigravity. Watchkeeper never runs Antigravity\'s agent or the Gemini CLI.';
  const paceLine = p.state === 'ok' && p.pace ? `Weekly Claude plan used: ${pct(p.pace.used)} (${paceSentence(p.pace, m.now)})` : 'Claude usage meter: waiting for reading.';
  return `<p class="control-state">${shape}<span class="orch-headline">${esc(headline)}</span></p>`
    + `<p class="hint">${esc(paceLine)}</p>`;
}

// P2-272 (B): sources found by discovery wait here for the owner's OK; nothing from them is indexed until then.
function renderSkillReview(lib) {
  const list = Array.isArray(lib.review) ? lib.review : [];
  const n = Number(lib.reviewCount) || list.length;
  if (!n) return '';
  return `<div class="skill-review-box"><p><strong>${esc(String(n))} to review</strong> <span class="hint">New skill sources. Nothing from them is used until you approve.</span></p>`
    + `<ul class="skill-review">` + list.map(r => {
      // The slug alone, the same as the gate and validateMessage; without a valid slug the buttons would post a refused message.
      const ref = typeof r.slug === 'string' && D.SOURCE_REF.test(r.slug) ? r.slug : '';
      const name = r.repo || r.slug;
      return `<li class="skill-review-item"><span class="skill-name">${esc(name)}</span>`
        + (r.stars ? ` <span class="badge">${esc(String(r.stars))}★</span>` : '')
        + (r.description ? ` <span class="hint">${esc(r.description)}</span>` : '')
        + (r.url ? ` <a href="${esc(r.url)}" title="Open the repository">Repository</a>` : '')
        + (ref ? `<span class="actions"><button type="button" class="btn btn-secondary btn-small" data-cmd="skillApprove" data-slug="${esc(ref)}">Approve</button>`
          + ` <button type="button" class="btn btn-secondary btn-small" data-cmd="skillReject" data-slug="${esc(ref)}">Reject</button></span>`
          : ` <span class="hint">This source has no valid slug in sources.json, so it cannot be approved here.</span>`) + `</li>`;
    }).join('') + `</ul></div>`;
}

function renderSkills(m, { withReview = true } = {}) {
  const lib = m.skillLibrary || { ready: false, total: 0, repos: 0, domains: [], items: [], sync: null };
  const now = m.now;
  let html = '';
  if (!lib.ready) {
    html += `<p class="empty">Skills index not initialized yet.</p>`
      + `<p class="hint">Click Sync skills above or run <code>node bin/wk-skill-sync.mjs run --force</code>.</p>`;
  } else {
    // P2-272 (B): the count is approved sources only (the index may still list staged ones).
    const srcN = lib.approvedCount || lib.repos;
    html += `<p class="big"><span class="num big-num">${esc(String(lib.total))}</span> <span class="big-label">indexed skills across ${esc(String(srcN))} ${lib.approvedCount ? 'approved' : 'curated &amp; trending'} libraries</span></p>`;
  }
  // P2-272 (P3-A): the review queue also has its own place in the Ops drawer; renderSections leaves it out here.
  if (withReview) html += renderSkillReview(lib);
  const sync = lib.sync;
  if (sync) {
    const syncWhen = sync.lastAt ? when(sync.lastAt, now) : 'never';
    const topNames = (sync.topTrending || []).slice(0, 3).map(t => `${t.repo} (${t.stars}★)`).join(', ');
    html += `<p class="hint">Daily GitHub trending sync: last run ${esc(syncWhen)}${sync.addedRepos && sync.addedRepos.length ? ` · +${sync.addedRepos.length} new repos` : ''}${topNames ? ` · Top: ${esc(topNames)}` : ''}.</p>`;
  } else {
    html += `<p class="hint">Auto-checks GitHub once per day for newly trending, most-forked, and top-rated skill repositories.</p>`;
  }
  if (lib.items && lib.items.length) {
    html += `<ul class="skills-grid">` + lib.items.slice(0, 60).map(s => {
      const qText = `${s.name} ${s.domain} ${s.repo} ${s.description}`.toLowerCase();
      return `<li class="skill-card" data-skill-domain="${esc(s.domain)}" data-skill-q="${esc(qText)}">`
        + `<div class="skill-top"><span class="skill-name">${esc(s.name)}</span>`
        + (s.trending ? ` <span class="badge badge-accent">Trending</span>` : '')
        + (s.stars ? ` <span class="badge">${esc(String(s.stars))}★</span>` : '')
        + `</div>`
        + `<span class="row-meta">${esc([s.domain, s.repo].filter(Boolean).join(' · '))}</span>`
        + (s.description ? `<p class="hint clamp">${esc(s.description)}</p>` : '')
        + `<div class="actions"><button type="button" class="btn btn-secondary btn-small" data-cmd="skillPin" data-skill="${esc(s.name || s.id)}">Use +skill</button></div>`
        + `</li>`;
    }).join('') + `</ul>`;
  }
  const learn = m.learning;
  if (learn && (learn.available || learn.snippetCount > 0 || learn.heuristicCount > 0)) {
    html += `<div class="wk-learning-box">`
      + `<h3>Autonomous Learning &amp; Verified Snippets</h3>`
      + `<p class="hint"><strong>${esc(String(learn.snippetCount || 0))}</strong> sanitized snippets (<strong>${esc(String(learn.verifiedCount || 0))}</strong> test-verified) · `
      + `<strong>${esc(String(learn.correctionCount || 0))}</strong> developer corrections · `
      + `<strong>${esc(String(learn.heuristicCount || 0))}</strong> active heuristics</p>`;
    if (Array.isArray(learn.topHeuristics) && learn.topHeuristics.length) {
      html += `<ul class="wk-learning-list">` + learn.topHeuristics.slice(0, 4).map(h =>
        `<li><span class="badge">${esc(h.language || 'all')}</span> <span class="badge">${esc(h.category || 'general')}</span> ${esc(h.rule_text)}</li>`
      ).join('') + `</ul>`;
    }
    if (Array.isArray(learn.topSnippets) && learn.topSnippets.length) {
      html += `<ul class="wk-learning-list">` + learn.topSnippets.slice(0, 4).map(s =>
        `<li><strong>${esc(s.title)}</strong> <span class="row-meta">${esc(s.language)} · ${esc(s.verification_status)}</span></li>`
      ).join('') + `</ul>`;
    }
    html += `</div>`;
  }
  return html;
}

function renderChatThread({ activeSession = null, claudeTranscript = null, confirmBeforeGo = false, untrusted = false } = {}) {
  const now = Date.now();
  if (claudeTranscript) {
    const tList = arr(claudeTranscript.turns);
    const workers = arr(claudeTranscript.members);
    let html = `<div class="chat-bar">`
      + `<div><strong>${esc(claudeTranscript.title || 'Claude Code Session')}</strong>`
      + `<div class="row-meta">${esc([claudeTranscript.project, claudeTranscript.model, claudeTranscript.cwd].filter(Boolean).join(' · '))}</div></div>`
      + `<div class="actions">`
      + `<button type="button" class="btn btn-small" data-cmd="chatContinueFromClaude" data-session-id="${esc(claudeTranscript.id)}"${untrusted ? ' disabled' : ''}>Take Over in Antigravity →</button>`
      + `</div></div>`;
    if (workers.length) {
      html += `<div class="chat-workers"><span class="row-meta">Mixed-model subagents: `
        + workers.map(w => `<span class="${modelBadgeClass(w.model, '')}">${esc(w.role)}: ${esc(w.model || 'Worker')}${w.effort ? ` (${esc(w.effort)})` : ''}</span>`).join(' ')
        + `</span></div>`;
    }
    html += `<div class="chat-msgs">`;
    if (!tList.length) {
      html += `<p class="hint">No parsed message turns yet in this transcript.</p>`;
    } else {
      for (const tr of tList) {
        if (tr.role === 'user') {
          html += `<article class="chat-bubble chat-user"><div class="chat-meta"><span>You</span>${tr.at ? `<span>${esc(when(tr.at, now))}</span>` : ''}</div><pre class="chat-pre">${esc(tr.text)}</pre></article>`;
        } else {
          html += `<article class="chat-bubble chat-assistant"><div class="chat-meta"><span class="${modelBadgeClass(tr.model, 'claude')}">${esc(tr.model || 'Claude')}</span>${tr.at ? `<span>${esc(when(tr.at, now))}</span>` : ''}</div>`;
          if (tr.tools && tr.tools.length) {
            html += `<div class="tool-chips">${tr.tools.map(tl => `<span class="tool-chip">${esc(tl)}</span>`).join('')}</div>`;
          }
          if (tr.thinking) {
            html += `<details class="think-box" open><summary>Thinking process (${esc(tr.model || 'Claude')})</summary><pre class="think-pre">${esc(tr.thinking)}</pre></details>`;
          }
          if (tr.text) {
            html += `<pre class="chat-pre">${esc(tr.text)}</pre>`;
          }
          html += `</article>`;
        }
      }
    }
    html += `</div>`;
    return html;
  }

  if (!activeSession || !arr(activeSession.turns).length) {
    return `<div class="chat-welcome">`
      + `<h3>Watchkeeper Session</h3>`
      + `<p class="hint">Watchkeeper rewrites your prompt, adds graph context and skills, and sends it to Claude, or to Gemini by quota when a Gemini API key is added in Settings. Otherwise Gemini work is queued for Antigravity (wk-task), which takes it when you run /wk-take-task there. Watchkeeper never runs Antigravity&#39;s agent or the Gemini CLI.</p>`
      + `<div class="actions"><button type="button" class="btn btn-secondary btn-small" data-cmd="chatTakeTask"${untrusted ? ' disabled' : ''}>Take a queued task (/wk-take-task)</button></div>`
      + `</div>`;
  }

  const turns = arr(activeSession.turns);
  const modBadges = arr(activeSession.modelsUsed).map(mName => `<span class="${modelBadgeClass(mName, '')}">${esc(mName)}</span>`).join(' ');
  const savedTotal = Number(activeSession.totalSavedTokens || 0);
  let html = `<div class="chat-bar">`
    + `<div><strong>${esc(activeSession.title || 'Session')}</strong> ${promptBadge(activeSession.promptMode)}`
    + `<div class="row-meta">${esc(plural(turns.length, 'turn'))}${savedTotal > 0 ? ` · Graphify saved ~${esc(tok(savedTotal))} tokens` : ''}${activeSession.taskId ? ` · Task: ${esc(activeSession.taskId)}` : ''}${activeSession.workspace ? ` · ${esc(activeSession.workspace)}` : ''}</div>`
    + (modBadges ? `<div class="chat-pill-row">${modBadges}</div>` : '')
    + `</div>`
    + `<div class="actions">`
    + `<button type="button" class="btn btn-secondary btn-small" data-cmd="chatTakeTask"${untrusted ? ' disabled' : ''}>/wk-take-task</button>`
    + `<button type="button" class="btn btn-secondary btn-small" data-cmd="chatHandoffToClaude" data-session-id="${esc(activeSession.id)}"${untrusted ? ' disabled' : ''}>Hand Off to Claude →</button>`
    + `</div>`
    + `</div><div class="chat-msgs">`;

  for (const t of turns) {
    const gf = t.graphify || {};
    const skills = arr(t.skills);
    const steps = arr(t.steps);
    html += `<article class="chat-turn" data-turn-id="${esc(t.id)}">`;
    html += `<div class="chat-bubble chat-user"><div class="chat-meta"><span>You</span><span>${esc(when(t.createdAt || now, now))}</span></div><pre class="chat-pre">${esc(t.rawPrompt)}</pre>${repromptDrawer(t, gf, skills)}</div>`;

    if (t.dag) {
      html += dagCard(t, activeSession.id, untrusted);
    } else if (t.status === 'preparing') {
      // S7: "Still planning…" appears only after the planner has taken a while (turn.planning), so it never flashes.
      html += t.planning
        ? `<div class="chat-confirm-card"><p class="control-state" role="status">${SHAPES.running}Still planning the steps…</p></div>`
        : `<div class="chat-confirm-card"><p class="control-state">${SHAPES.running}Preparing Graphify context, auto skills, target/mode/model &amp; re-prompted plan…</p></div>`;
    } else if (t.status === 'awaiting_confirm') {
      const cTarget = t.chosenTarget || t.autoTarget || 'antigravity';
      const cMode = t.chosenMode || t.autoMode || 'balanced';
      const cRoute = t.chosenRoute || 'auto';
      html += `<div class="chat-confirm-card" data-confirm-card="${esc(t.id)}">`
        + `<div class="confirm-head">`
        + `<span class="confirm-title">${SHAPES.holding}Review Re-Prompted Plan &amp; Press Go</span>`
        + (gf.available ? `<span class="model-badge model-badge-graphify">Graphify: ${esc(String(gf.matchedNodes || 0))}/${esc(String(gf.totalNodes || 0))} nodes · ~${esc(String(gf.savedPct || 0))}% saved (~${esc(tok(gf.savedTokens || 0))})</span>` : '')
        + `<span class="${modelBadgeClass(t.plannedModel, t.plannedProvider)}">Plan: ${esc(t.plannedModel || 'Auto')} → ${esc(TARGET_LABELS[cTarget] || cTarget)}</span>`
        + `</div>`
        + `<label class="label" for="confirm-spec-${esc(t.id)}">Re-Prompted Specification <span class="hint">(normalized by ${esc(t.repromptModel || 'Watchkeeper')})</span></label>`
        + `<textarea class="confirm-spec" id="confirm-spec-${esc(t.id)}" rows="6">${esc(t.repromptedText || t.rawPrompt)}</textarea>`
        + `<div class="confirm-grid">`
        + `<div><label class="label" for="confirm-target-${esc(t.id)}">Target</label><select id="confirm-target-${esc(t.id)}">`
        + ['claude', 'antigravity', 'general'].map(k => `<option value="${k}"${cTarget === k ? ' selected' : ''}>${esc(TARGET_LABELS[k])}${t.autoTarget === k ? ' (Auto)' : ''}</option>`).join('')
        + `</select></div>`
        + `<div><label class="label" for="confirm-mode-${esc(t.id)}">Auto Mode</label><select id="confirm-mode-${esc(t.id)}">`
        + ['balanced', 'spec', 'bugfix', 'refactor', 'concise'].map(k => `<option value="${k}"${cMode === k ? ' selected' : ''}>${esc(MODE_LABELS[k])}${t.autoMode === k ? ' (Auto)' : ''}</option>`).join('')
        + `</select></div>`
        + `<div><label class="label" for="confirm-route-${esc(t.id)}">Route</label><select id="confirm-route-${esc(t.id)}">`
        + ['auto', 'carbon', 'claude', 'gemini'].map(k => `<option value="${k}"${cRoute === k ? ' selected' : ''}>${esc(ROUTE_LABELS[k])}</option>`).join('')
        + `</select></div></div>`
        + `<div class="confirm-skills"><span class="label">Selected Skills <span class="hint">(${esc(String(skills.length))})</span></span>`
        + `<div class="skill-chips-row" data-skills-for="${esc(t.id)}">`
        + (skills.length
          ? skills.map(sk => {
            const nm = typeof sk === 'string' ? sk : sk.name;
            return `<span class="skill-chip" data-chip="${esc(nm)}">+skill:${esc(nm)} <button type="button" class="chip-x" data-cmd="chatDropSkill" data-turn-id="${esc(t.id)}" data-skill="${esc(nm)}" aria-label="Remove ${esc(nm)}">×</button></span>`;
          }).join('')
          : `<span class="hint">No extra domain skills matched; Watchkeeper core rules apply.</span>`)
        + `</div>`
        + `<input type="text" class="confirm-skills-edit" id="confirm-skills-${esc(t.id)}" value="${esc(skills.map(sk => `+skill:${typeof sk === 'string' ? sk : sk.name}`).join(' '))}" placeholder="+skill:name …"></div>`;

      if (gf.available) {
        html += `<details class="gf-details"><summary>Graphify 2-Hop Context (${esc(String(gf.matchedEdges || 0))} edges · focus: ${esc((gf.topFiles || []).slice(0, 3).join(', ') || 'index')})</summary><pre class="think-pre">${esc(gf.contextBlock || '')}</pre></details>`;
      }
      if (t.routeReason) {
        html += `<p class="hint">Routing: ${esc(t.routeReason)}</p>`;
      }
      html += `<div class="actions">`
        + `<button type="button" class="btn" data-cmd="chatConfirm" data-session-id="${esc(activeSession.id)}" data-turn-id="${esc(t.id)}"${untrusted ? ' disabled' : ''}>Go →</button>`
        + `<button type="button" class="btn btn-secondary" data-cmd="chatSendToIde" data-session-id="${esc(activeSession.id)}" data-turn-id="${esc(t.id)}"${untrusted ? ' disabled' : ''}>Send to ${esc(TARGET_LABELS[cTarget] || 'IDE Chat')}</button>`
        + `<button type="button" class="btn btn-secondary" data-cmd="chatCancel" data-session-id="${esc(activeSession.id)}" data-turn-id="${esc(t.id)}">Cancel</button>`
        + `</div></div>`;
    } else if (t.repromptedText) {
      const cTarget = t.chosenTarget || t.autoTarget || 'antigravity';
      const cMode = t.chosenMode || t.autoMode || 'balanced';
      html += `<details class="confirm-summary"><summary>Re-prompted specification (${esc(TARGET_LABELS[cTarget] || cTarget)} · ${esc(MODE_LABELS[cMode] || cMode)}${skills.length ? ` · ${skills.length} skill(s)` : ''}${gf.savedPct ? ` · Graphify -${gf.savedPct}% tok` : ''})</summary><pre class="think-pre">${esc(t.repromptedText)}</pre></details>`;
    }

    if (steps.length) {
      html += `<div class="think-timeline">`
        + steps.map(st => {
          const shape = st.status === 'running' ? SHAPES.running : st.status === 'failover' ? SHAPES.holding : SHAPES.done;
          const toolsHtml = arr(st.tools).length ? `<div class="tool-chips">${arr(st.tools).map(tl => `<span class="tool-chip">${esc(tl)}</span>`).join('')}</div>` : '';
          const hasThink = Boolean(st.thinking && String(st.thinking).trim());
          return `<div class="think-step think-step-${esc(st.status || 'done')}">`
            + `<div class="think-head">${shape}<span class="think-label">${esc(st.label || st.phase || 'Step')}</span>`
            + `<span class="${modelBadgeClass(st.model, st.provider)}">${esc(st.model || st.provider || 'Model')}</span>`
            + (st.tokens ? `<span class="row-meta">${esc(tok(st.tokens))} tok</span>` : '')
            + `</div>`
            + (st.detail ? `<p class="hint think-detail">${esc(st.detail)}</p>` : '')
            + toolsHtml
            + (hasThink ? `<details class="think-box"${st.status === 'running' || st.phase === 'main_task' ? ' open' : ''}><summary>Thinking process (${esc(st.model || st.provider || 'Model')})</summary><pre class="think-pre">${esc(st.thinking)}</pre></details>` : '')
            + `</div>`;
        }).join('')
        + `</div>`;
    }

    if (t.dag) {
      // The plan card above says the state in words.
    } else if (t.status === 'running' && !t.answer) {
      html += `<div class="chat-bubble chat-assistant"><p class="control-state">${SHAPES.running}Running via ${esc(t.plannedModel || 'Orchestrator')}…</p></div>`;
    } else if (t.status === 'cancelled') {
      html += `<p class="hint">Turn cancelled.</p>`;
    } else if (t.error) {
      html += `<div class="chat-bubble chat-error"><p class="feedback-error">${esc(t.error)}</p></div>`;
    } else if (t.answer) {
      html += `<div class="chat-bubble chat-assistant">`
        + `<div class="chat-meta"><span class="${modelBadgeClass(t.answerModel, t.answerProvider)}">${esc(t.answerModel || t.answerProvider || 'Watchkeeper')}</span>${t.carbonFailover ? '<span class="badge badge-accent">Queued for Antigravity</span>' : ''}</div>`
        + `<pre class="chat-pre chat-answer-body">${esc(t.answer)}</pre>`
        + `<div class="actions"><button type="button" class="btn btn-secondary btn-small" data-cmd="chatCopyAnswer">Copy</button>`
        + `<button type="button" class="btn btn-secondary btn-small" data-cmd="chatSendToIde" data-session-id="${esc(activeSession.id)}" data-turn-id="${esc(t.id)}"${untrusted ? ' disabled' : ''}>Send to IDE</button></div>`
        + `</div>`;
    } else if (t.status === 'done') {
      html += `<div class="chat-bubble chat-assistant"><p class="hint">Completed without text output (prompt copied for Antigravity IDE Chat).</p></div>`;
    }
    html += `</article>`;
  }
  html += `</div>`;
  return html;
}

// P2-272: the real graph state in plain words: "1754/1754 files · 2m old · 4 changed" (says "truncated" when the ceiling cut it).
function graphBadgeText(gf) {
  const st = gf && gf.status;
  if (!st || !st.known) return gf && gf.available ? `Graph: ${gf.totalNodes} nodes` : 'Graph: not built yet';
  const age = st.ageMs == null ? '' : st.ageMs < 60000 ? 'just now' : st.ageMs < 3600000 ? `${Math.floor(st.ageMs / 60000)}m old` : st.ageMs < 86400000 ? `${Math.floor(st.ageMs / 3600000)}h old` : `${Math.floor(st.ageMs / 86400000)}d old`;
  return ['Graph: ' + st.indexed + '/' + st.total + ' files' + (st.truncated ? ' (truncated)' : ''), age, st.changed ? `${st.changed} changed` : ''].filter(Boolean).join(' · ');
}
function graphBadge(gf) {
  return `<span class="model-badge model-badge-graphify" id="graph-badge">${esc(graphBadgeText(gf))}</span> `
    + `<button type="button" class="btn btn-secondary btn-small" data-cmd="graphRefresh" title="Update the graph for the files that changed">Refresh graph</button>`;
}

// P2-272 (P3-A): a session counts as archived when it says so, or when it has been quiet for a week and is not
// running or waiting on a confirm. Archived ones move to the bottom group; nothing is hidden or deleted.
const ARCHIVE_AFTER_MS = 7 * 24 * 3600 * 1000;
// P2-272 (P3 N5): the session open in the canvas always stays in the active group.
function isArchivedWk(ws, now, activeId) {
  if (activeId && ws.id === activeId) return false;
  if (ws.archived === true) return true;
  if (ws.lastStatus === 'running' || ws.lastStatus === 'preparing' || ws.lastStatus === 'awaiting_confirm') return false;
  return !!ws.updatedAt && (now || Date.now()) - Number(ws.updatedAt) > ARCHIVE_AFTER_MS;
}
// P2-272 (P3-B, spec 3.2): the bubble shows only what was typed; the "re-prompted" pill opens a read-only drawer with what was sent.
function repromptDrawer(t, gf, skills) {
  if (t.promptMode === 'raw' || !t.repromptedText) return '';
  const names = skills.map(x => (x && (x.name || x.id)) || '').filter(Boolean);
  const files = arr(gf.topFiles).map(f => (typeof f === 'string' ? f : (f && (f.path || f.file)) || '')).filter(Boolean).slice(0, 8);
  const rows = [];
  rows.push(`<dt>Graph nodes</dt><dd>${gf.available ? `${esc(String(gf.matchedNodes || 0))} of ${esc(String(gf.totalNodes || 0))}` : 'no graph used'}</dd>`);
  if (files.length) rows.push(`<dt>Top files</dt><dd><ul class="rp-files">${files.map(f => `<li>${esc(f)}</li>`).join('')}</ul></dd>`);
  rows.push(`<dt>Time</dt><dd>${Number.isFinite(Number(t.repromptMs)) && t.repromptMs != null ? esc(`${(Number(t.repromptMs) / 1000).toFixed(1)} s`) : 'not recorded'}</dd>`);
  rows.push(`<dt>Skills</dt><dd>${names.length ? esc(names.join(', ')) : 'none'}</dd>`);
  return `<details class="rp-drawer"><summary class="rp-pill">${ICONS.reprompt}re-prompted</summary>`
    + `<div class="rp-body"><p class="label">Compiled prompt (read-only)</p><pre class="chat-pre rp-compiled">${esc(t.repromptedText)}</pre>`
    + `<dl class="rp-facts">${rows.join('')}</dl></div></details>`;
}
// P2-272 (P3 S2, N3): the title gets the full width (two lines at most); the second line holds the badge, the meta
// and the row's one action. Each meta piece keeps its words together (no-break spaces), so "2 turns" never splits.
const NB = s => String(s || '').replace(/ /g, ' ');
const cut60 = s => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > 60 ? `${t.slice(0, 59)}…` : t; };
const rowNoteSlot = id => `<p class="rail-note" data-row-note="${esc(id)}" role="status" aria-live="polite" hidden></p>`;
function railWk(ws, m) {
  const isCur = m.activeChatSessionId && m.activeChatSessionId === ws.id;
  const sh = ws.lastStatus === 'running' || ws.lastStatus === 'preparing' ? SHAPES.running : ws.lastStatus === 'awaiting_confirm' ? SHAPES.holding : SHAPES.done;
  const sub = [plural(ws.turnCount || 0, 'turn'), ws.updatedAt ? ago(ws.updatedAt, m.now) : '', ws.modelsUsed && ws.modelsUsed.length ? ws.modelsUsed[ws.modelsUsed.length - 1] : ''].filter(Boolean).map(NB).join(' · ');
  const title = cut60(ws.title || ws.id);
  // M1: no × on a live row; "✓ Done" archives it (reason done) and the archive offers Reopen and Delete for good.
  return `<li class="rail-item${isCur ? ' rail-item-active' : ''}">`
    + `<button type="button" class="rail-btn" data-cmd="chatSelect" data-session-id="${esc(ws.id)}" aria-label="${esc(`Open "${title}"`)}">`
    + `<span class="row-main row-title">${sh}<span class="row-title-text">${esc(ws.title)}</span></span>`
    + (ws.totalSavedTokens ? `<span class="row-meta">${esc(NB(`Graphify -${tok(ws.totalSavedTokens)} tok`))}</span>` : '')
    + `</button>`
    + `<div class="row-sub"><span class="row-meta">${promptBadge(ws.promptMode)} ${esc(sub)}</span>`
    + `<button type="button" class="rail-done" data-cmd="chatDone" data-session-id="${esc(ws.id)}" aria-label="${esc(`Done: archive "${title}"`)}">✓ Done</button></div>`
    + rowNoteSlot(ws.id)
    + `</li>`;
}
// A session archived to <data>/chat-sessions/archive/: read-only here. Reopen brings it back; Delete for good asks
// first on a line under the row, and only its [Delete] removes the file (P3 M1).
const ARCHIVE_REASONS = { done: 'marked done', 'task-done': 'its task finished', 'claude-finished': 'Claude finished', stale: 'idle', manual: 'archived', deleted: 'removed from the list', overflow: 'archived to make room' };
function railArchived(a, m) {
  const why = ARCHIVE_REASONS[a.archiveReason] || 'archived';
  const sub = [plural(a.turnCount || 0, 'turn'), a.archivedAt ? `${why} ${when(a.archivedAt, m.now)}` : why].map(NB).join(' · ');
  const title = cut60(a.title || a.id), id = esc(a.id);
  return `<li class="rail-item rail-item-archived">`
    + `<span class="rail-btn rail-static"><span class="row-main row-title">${SHAPES.done}<span class="row-title-text">${esc(a.title || a.id)}</span></span></span>`
    + `<div class="row-sub"><span class="row-meta">${promptBadge(a.promptMode)} ${esc(sub)}</span>`
    + `<span class="row-actions"><button type="button" class="rail-done" data-cmd="chatReopen" data-session-id="${id}" aria-label="${esc(`Reopen "${title}"`)}">Reopen</button>`
    + `<button type="button" class="rail-done rail-purge" data-cmd="chatPurgeAsk" data-session-id="${id}" aria-expanded="false" aria-controls="wk-purge-${id}" aria-label="${esc(`Delete "${title}" for good`)}">Delete for good</button></span></div>`
    + `<div class="rail-confirm" id="wk-purge-${id}" data-purge-confirm="${id}" hidden><p class="rail-confirm-q">Delete this session for good? This cannot be undone.</p>`
    + `<span class="row-actions"><button type="button" class="btn btn-small btn-danger" data-cmd="chatPurge" data-session-id="${id}" aria-label="${esc(`Delete "${title}"`)}">Delete</button>`
    + `<button type="button" class="btn btn-small btn-secondary" data-cmd="chatPurgeKeep" data-session-id="${id}" aria-label="${esc(`Keep "${title}"`)}">Keep</button></span></div>`
    + rowNoteSlot(a.id)
    + `</li>`;
}
function railClaude(x, m) {
  const isCur = m.activeClaudeSessionId && m.activeClaudeSessionId === x.id;
  const workerNote = x.members && x.members.length ? ` · +${x.members.length}` : '';
  return `<li class="rail-item${isCur ? ' rail-item-active' : ''}">`
    + `<button type="button" class="rail-btn" data-cmd="chatInspectClaude" data-session-id="${esc(x.id)}">`
    + `<span class="row-main">${x.active ? SHAPES.running : SHAPES.unknown}${esc(x.title)}</span>`
    + `<span class="row-meta">${esc([x.project, x.model].filter(Boolean).join(' · '))}${esc(workerNote)}</span>`
    + `</button></li>`;
}

// The left rail's body: active sessions only, then Archived (N) at the bottom, then the counts and the graph badge.
// The rail's "+ New Session" button and the limits footer live in the page frame (renderPage).
function renderRail(m) {
  const s = m.sessions || { sessions: [] }, claudeSessions = s.sessions || [], activeCount = claudeSessions.filter(x => x.active).length;
  const wkSessions = arr(m.chatSessions);
  const qCnt = waitingCount(m);
  const runJobs = arr(m.jobs).filter(j => j.state === 'running' || j.state === 'queued');
  const qTasks = ((m.tasks && m.tasks.items) || []).filter(t => t.status === 'queued' || t.status === 'taken');
  const aid = m.activeChatSessionId;
  const wkOn = wkSessions.filter(ws => !isArchivedWk(ws, m.now, aid)), wkOff = wkSessions.filter(ws => isArchivedWk(ws, m.now, aid));
  const clOn = claudeSessions.filter(x => x.active), clOff = claudeSessions.filter(x => !x.active);

  let html = `<div class="rail-group"><h3 class="rail-h">Watchkeeper</h3>`;
  html += wkOn.length ? `<ul class="rail-list">${wkOn.map(ws => railWk(ws, m)).join('')}</ul>`
    : `<p class="hint">${wkSessions.length ? 'No active Watchkeeper session.' : 'No Watchkeeper sessions yet. Ask below to start one.'}</p>`;
  html += `</div>`;

  html += `<div class="rail-group"><h3 class="rail-h">Claude &amp; IDE Sessions (${esc(String(clOn.length))})</h3>`;
  html += clOn.length ? `<ul class="rail-list">${clOn.map(x => railClaude(x, m)).join('')}</ul>`
    : `<p class="hint">${claudeSessions.length ? 'None active right now.' : 'No recent Claude sessions.'}</p>`;
  html += `</div>`;

  const wkArch = arr(m.archivedChatSessions).filter(a => a && a.id);
  const offN = wkOff.length + wkArch.length + clOff.length;
  html += `<details class="rail-archived" data-id="rail-archived"><summary>Archived (${esc(String(offN))})</summary>`;
  if (!offN) html += `<p class="hint">Nothing archived.</p>`;
  if (wkOff.length || wkArch.length) html += `<h4>Watchkeeper</h4><ul class="rail-list">${wkOff.map(ws => railWk(ws, m)).join('')}${wkArch.map(a => railArchived(a, m)).join('')}</ul>`;
  if (clOff.length) html += `<h4>Claude &amp; IDE</h4><ul class="rail-list">${clOff.map(x => railClaude(x, m)).join('')}</ul>`;
  html += `</details>`;

  html += `<div class="rail-foot">`
    + `<p class="hint">${esc(plural(activeCount, 'active'))} · ${esc(plural(runJobs.length, 'job'))} · ${esc(plural(qTasks.length, 'task'))}</p>`;
  if (qCnt) html += `<p class="warn">${SHAPES.holding}<button type="button" class="link-btn" data-cmd="toggleWaiting" aria-controls="wk-waiting-panel">${esc(plural(qCnt, 'item'))} waiting for you</button></p>`;
  html += `</div>`;
  return html;
}

// Questions, suggestions and worktree removals that still wait for the owner.
function waitingCount(m) {
  const q = ((m.questions && m.questions.items) || []).length, s = ((m.suggestions && m.suggestions.items) || []).length;
  const r = Array.isArray(m.removals) ? m.removals.filter(x => x && !x.done).length : 0;
  return q + s + r;
}

// The slim status bar: the one line from bin/wk-status.mjs --json, and the "Waiting for you (N)" pill only when N > 0.
function renderStatusBar(m) {
  if (sessionsOnly(m)) return '';
  const n = waitingCount(m);
  // P2-272 (P3-C): the graph shows once here (a copy of the drawer's #graph-badge, filled by media/main.js)
  return `<p class="wk-status-line">${esc(statusLineText(m))}</p>`
    + `<span class="model-badge model-badge-graphify wk-status-graph" data-graph-copy>${esc(graphBadgeText(m.graphify))}</span>`
    + `<button type="button" class="wk-pill wk-usage-pill" data-cmd="openUsage" aria-controls="wk-limits">${esc(usageSummary(m))}</button>`
    + (n > 0 ? `<button type="button" class="wk-pill" data-cmd="toggleWaiting" aria-expanded="false" aria-controls="wk-waiting-panel">Waiting for you (${esc(String(n))})</button>` : '');
}

// S1: the status bar's one-line usage summary (plain text); it opens the usage card.
function usageSummary(m) {
  const p = m.pace || {};
  if (m.carbon && m.carbon.claudeExhausted) return 'Claude limits reached';
  return p.state === 'ok' && p.pace ? `Weekly Claude ${pct(p.pace.used)}` : 'Usage';
}

// The limits footer's summary line (the card itself is the pace section, which opens inline under it).
function limitsLabel(m) {
  const p = m.pace || {};
  if (p.state === 'ok' && p.pace) return `Limits · Weekly Claude ${pct(p.pace.used)}${m.carbon && m.carbon.claudeExhausted ? ' · <strong>Claude limits reached</strong>' : ''}`;
  return 'Limits';
}

// An untrusted folder: the buttons that run a program are off (media/main.js), and this line says why.
const UNTRUSTED_NOTE = '<p class="hint" data-untrusted="1">This folder is not trusted, so the buttons that run something are off here: answering, deciding, adding a task, Re-Prompt execution, Orchestrator runs, skills sync, jobs and the phone. Trust the folder (Manage Workspace Trust) to use them.</p>';
// P2-277 Bridge: Claude's tower on the left, Gemini's on the right; the last crossings walk across as dots.
// Colours by event: amber queued/written, blue taken/consumed, green done, red stalled/requeued/failed.
// Under reduced motion (main.css) the dots stand still and the arrow shows the direction. Data: watch.json only.
const BRIDGE_TONE = { queued: 'amber', written: 'amber', taken: 'blue', consumed: 'blue', done: 'green', failed: 'red', requeued: 'red', stalled: 'red' };
const BRIDGE_WORD = { queued: 'queued', written: 'handoff written', taken: 'taken', consumed: 'handoff taken', done: 'done', failed: 'failed', requeued: 'requeued', unknown: 'crossed' };
const sideOf = v => (/claude/i.test(String(v || '')) ? 'claude' : /gemini|antigravity|agy/i.test(String(v || '')) ? 'gemini' : '');
function renderBridge(m) {
  const b = (m && m.bridge) || {};
  if (!b.found) return '<p class="empty">Bridge has no news yet. The checker writes it every 30 seconds once Watchkeeper is installed.</p>';
  const c = b.counts || {}, now = m.now || Date.now();
  const all = Array.isArray(b.crossings) ? b.crossings : [];
  const shown = all.slice(-5);
  const dots = shown.map((x, i) => {
    const ltr = sideOf(x.from) !== 'gemini';   // from Claude (or unknown) walks left to right
    const tone = BRIDGE_TONE[x.event] || 'amber';
    return `<circle class="bridge-dot tone-${tone} ${ltr ? 'ltr' : 'rtl'} d${i}" cx="${ltr ? 60 + i * 30 : 260 - i * 30}" cy="44" r="5"><title>${esc(BRIDGE_WORD[x.event] || 'crossed')}: ${esc(x.title || x.id || '')}</title></circle>`;
  }).join('');
  const lastLtr = shown.length ? sideOf(shown[shown.length - 1].from) !== 'gemini' : true;
  const svg = `<svg class="bridge-svg" viewBox="0 0 320 90" role="img" aria-label="Bridge between Claude and Gemini: ${c.waiting_for_claude || 0} waiting for Claude, ${c.queued_for_gemini || 0} queued for Gemini">
  <rect class="bridge-tower" x="8" y="12" width="36" height="66" rx="4"/><text class="bridge-tower-label" x="26" y="86" text-anchor="middle">Claude</text>
  <rect class="bridge-tower" x="276" y="12" width="36" height="66" rx="4"/><text class="bridge-tower-label" x="294" y="86" text-anchor="middle">Gemini</text>
  <path class="bridge-deck" d="M44 52 Q160 30 276 52"/>
  <path class="bridge-arrow" d="${lastLtr ? 'M150 66 L170 66 M164 61 L170 66 L164 71' : 'M170 66 L150 66 M156 61 L150 66 L156 71'}"/>
  ${dots}</svg>`;
  const status = !b.on ? '<p class="bridge-state">Bridge is off. <code>wk-bridge on</code> turns it on.</p>'
    : `<p class="bridge-state">Bridge is on. Waiting in Claude: <strong>${esc(b.routes && b.routes.claude_wait || 'nobody')}</strong>; hooks are ${esc(b.routes && b.routes.hooks || 'off')}.</p>`;
  const heldIds = Array.isArray(b.held) ? b.held : [];
  const heldLine = heldIds.length ? `<p class="bridge-held"><span class="bridge-chip tone-amber held-chip">held</span> ${esc(heldIds.length === 1 ? '1 task on hold' : heldIds.length + ' tasks on hold')}: ${heldIds.map(id => `<code>${esc(id)}</code>`).join(', ')}. <code>wk-task release &lt;id&gt;</code> lifts a hold.</p>` : '';
  const towers = `<div class="bridge-counts">
  <dl class="bridge-side"><dt>Claude</dt><dd>${c.waiting_for_claude || 0} waiting</dd></dl>
  <dl class="bridge-side bridge-mid"><dt>On the way</dt><dd>${c.in_flight || 0} in flight</dd><dd>${c.done_24h || 0} done in 24 h</dd>${c.stalled ? `<dd class="bridge-stalled">${c.stalled} stalled</dd>` : ''}</dl>
  <dl class="bridge-side"><dt>Gemini</dt><dd>${c.queued_for_gemini || 0} queued</dd></dl></div>`;
  const list = shown.length ? `<ol class="bridge-log">${shown.slice().reverse().map(x => {
    const t = Date.parse(x.at);
    const dir = sideOf(x.from) === 'gemini' ? 'Gemini to Claude' : 'Claude to Gemini';
    return `<li><span class="bridge-chip tone-${BRIDGE_TONE[x.event] || 'amber'}">${esc(BRIDGE_WORD[x.event] || 'crossed')}</span> ${esc(x.title || '(no title)')} <span class="muted">· ${dir}${Number.isFinite(t) ? ' · ' + esc(ago(t, now)) : ''}</span></li>`;
  }).join('')}</ol>` : '<p class="empty">Nothing has crossed yet.</p>';
  const buttons = !isLocal(m) ? localLine()
    : `<div class="btn-row">${c.waiting_for_claude ? `<button type="button" class="btn btn-primary" data-cmd="bridgeOpenClaude" data-repo="${esc(b.claudeRepo || '')}">Open in Claude</button>` : ''}${b.taskId ? `<button type="button" class="btn btn-secondary" data-cmd="bridgeOpenAntigravity" data-task-id="${esc(b.taskId)}">Open in Antigravity</button>` : ''}</div>`;
  return status + heldLine + svg + towers + list + buttons;
}

function renderSections(m, open) {
  const lite = sessionsOnly(m), local = isLocal(m), untrusted = local && !lite && m.untrusted === true;
  return {
    mode: lite ? 'sessions' : 'full', untrusted, about: local ? renderAbout(m) : renderAboutWeb(m), status: (local ? renderStatus(m) : webStatus(m)) + (untrusted ? UNTRUSTED_NOTE : ''), pace: renderPace(m), spend: renderSpend(m), sessions: renderSessions(m, open), advice: renderAdvice(m), inbox: renderInbox(m), controls: renderControls(m), version: renderUpdate(m) + (local && !lite ? renderChannelUpdate(m) : ''),
    updated: `Updated ${when(m.now, m.now).replace('today ', '')}`,
    // P2-223: the new sections (data-needs="waiting" and "gemini") show only with the plugin
    waiting: lite ? '' : renderWaiting(m), bridge: lite ? '' : renderBridge(m), gemini: lite ? '' : renderGemini(m), routes: lite ? '' : renderRoutes(m),
    // P2-227: jobs, projects and the phone (data-needs "jobs", "projects", "phone"), also only with the plugin
    jobs: lite ? '' : renderJobs(m), projects: lite ? '' : renderProjects(m), phone: lite ? '' : renderPhone(m),
    // v0.8.0: active Re-Prompt / Carbon High Orchestrator / Skills Library / Wide Rail
    orchestrator: lite ? '' : renderOrchestrator(m),
    skills: lite ? '' : renderSkills(m, { withReview: false }),
    // P2-272 (P3-A): the frame. The review queue sits in the Ops drawer; the status bar and the limits footer's label.
    skillReview: lite ? '' : (renderSkillReview(m.skillLibrary || {}) || '<p class="empty">Nothing to review.</p>'),
    statusbar: lite ? '' : renderStatusBar(m),
    limits: lite ? '' : limitsLabel(m),
    // P2-272 (P3-B): the usage card carries the account email, so only the Mac's panel gets it, never the phone page
    usage: (lite || !local) ? '' : renderUsage(m),
    // P2-272 (P3-C): the developer's signed messages (the Mac's panel only) and the graph, once, in the drawer
    messages: (lite || !local) ? '' : renderChannel(m),
    graph: lite ? '' : graphBadge(m.graphify),
    skillDomains: lite ? [] : ((m.skillLibrary && m.skillLibrary.domains) || []).map(d => d.domain),
    rail: lite ? '' : renderRail(m),
    show: { waiting: !lite, bridge: !lite, gemini: !lite, jobs: !lite, projects: !lite, phone: !lite }
  };
}

function renderPage({ nonce, cspSource, styleUris = [], scriptUri, bodyClass = '', fullIde = false }) {
  const csp = `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; font-src ${cspSource}; script-src 'nonce-${nonce}';`;
  const cls = [bodyClass, fullIde ? 'wk-full-ide' : ''].filter(Boolean).join(' ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp.replace(/[&<>"]/g, '')}">
<meta name="viewport" content="width=device-width, initial-scale=1">
${styleUris.map(u => `<link rel="stylesheet" href="${esc(u)}">`).join('\n')}
<title>Watchkeeper</title>
</head>
<body${cls ? ` class="${esc(cls)}"` : ''}>
<main>
  <header class="top">
    <div class="slot" data-slot="status"><p class="status status-unknown">${SHAPES.unknown}<span class="status-word">Reading…</span></p></div>
    <div class="top-actions">
      <button type="button" class="btn btn-secondary btn-small wk-only-sidebar" data-cmd="openWorkspace">Full IDE</button>
      <button type="button" class="btn btn-secondary btn-small wk-only-full" data-cmd="toggleMaximize">Maximize</button>
      <button type="button" class="btn btn-secondary btn-small wk-only-full" data-cmd="popOutWorkspace">Pop Out</button>
      <button type="button" class="btn btn-secondary btn-small" data-cmd="toggleOps" aria-expanded="false" aria-controls="wk-ops" data-plugin-only="1" hidden>Controls and settings</button>
      <button type="button" class="btn btn-secondary btn-small" data-cmd="refresh">Refresh</button>
      <span class="updated slot" data-slot="updated"></span>
    </div>
  </header>
  <div class="wk-statusbar slot" data-slot="statusbar" data-plugin-only="1" hidden></div>
  <div id="wk-waiting-panel" class="wk-inline-panel" hidden>
  <section aria-labelledby="h-waiting" data-needs="waiting" hidden><h2 id="h-waiting">Waiting for you</h2><div class="slot" data-slot="waiting"></div>
    <p class="feedback" id="feedback-waiting" aria-live="polite"></p></section>
  </div>
  <div id="wk-ops" class="wk-drawer" role="region" aria-label="Controls and settings" hidden>
  <div class="wk-drawer-head"><p class="wk-drawer-title">Controls and settings</p><button type="button" class="btn btn-secondary btn-small" data-cmd="toggleOps" aria-expanded="true" aria-controls="wk-ops">Close</button></div>
  <section aria-labelledby="h-controls" data-needs="plugin" hidden><h2 id="h-controls">Stop switch</h2><div class="slot" data-slot="controls"></div>
    <p class="hint">${esc(PANEL_WRITES)}</p></section>
  <details class="ops-group" id="ops-tasks" data-id="ops-tasks" data-ops-group><summary>Tasks, jobs and sessions</summary>
  <section id="sec-orchestrator" aria-labelledby="h-orchestrator" data-plugin-only="1" data-tab-group="tasks" hidden>
    <h2 id="h-orchestrator">Run a task</h2>
    <div class="slot" data-slot="orchestrator"></div>
    <label class="label" for="orch-prompt">Task</label>
    <textarea id="orch-prompt" rows="3" maxlength="${D.MAX_PROMPT}" placeholder="Auto picks Claude, or Gemini with an API key, by quota…"></textarea>
    <label class="label" for="orch-prefer">Provider</label>
    <select id="orch-prefer"><option value="auto">Auto (by quota)</option><option value="carbon">Gemini only (API key or queue)</option><option value="claude">Prefer Claude Code</option><option value="gemini">Prefer Gemini (API key or queue)</option></select>
    <div class="actions"><button type="button" class="btn" data-cmd="orchestrateRun">Run</button></div>
    <pre class="orch-out" id="orch-output" hidden></pre>
    <p class="feedback" id="feedback-orchestrator" aria-live="polite"></p>
  </section>
  <section aria-labelledby="h-jobs" data-needs="jobs" hidden><h2 id="h-jobs">Jobs</h2><div class="slot" data-slot="jobs"></div>
    <p class="feedback" id="feedback-jobs" aria-live="polite"></p></section>
  <section id="sec-sessions" aria-labelledby="h-sessions"><h2 id="h-sessions">Sessions and workers</h2><div class="slot" data-slot="sessions"></div></section>
  </details>
  <details class="ops-group" id="ops-bridge" data-id="ops-bridge" data-ops-group><summary>Bridge</summary>
  <section aria-labelledby="h-bridge" data-needs="bridge" hidden><h2 id="h-bridge">Bridge</h2><div class="slot" data-slot="bridge"></div>
    <p class="feedback" id="feedback-bridge" aria-live="polite"></p></section>
  </details>
  <details class="ops-group" id="ops-gemini" data-id="ops-gemini" data-ops-group><summary>Gemini queue</summary>
  <section aria-labelledby="h-gemini" data-needs="gemini" hidden><h2 id="h-gemini">Gemini</h2><div class="slot" data-slot="gemini"></div>
    <p class="feedback" id="feedback-gemini" aria-live="polite"></p>
    <h3 id="h-task">Hand a task to Gemini</h3>
    <label for="task-title" class="label">Title</label>
    <input id="task-title" type="text" maxlength="200" autocomplete="off" spellcheck="true">
    <label for="task-text" class="label">Details</label>
    <textarea id="task-text" rows="4" maxlength="${D.MAX_TEXT}" aria-describedby="task-help"></textarea>
    <label for="task-kind" class="label">Kind</label>
    <select id="task-kind"><option value="auto">Let Watchkeeper choose</option>${D.TASK_KINDS.map(k => `<option value="${k}">${esc(KIND_WORDS[k])}: ${esc(KIND_FOR[k])}</option>`).join('')}</select>
    <label for="task-test" class="label">Test command</label>
    <input id="task-test" type="text" maxlength="500" autocomplete="off" spellcheck="false" placeholder="npm test (optional)">
    <div class="actions"><button type="button" class="btn" data-cmd="addTask">Add to Gemini's queue</button></div>
    <p class="hint" id="task-help">The task is for the first folder open in this window. Gemini works in a copy. Watchkeeper checks the changed files, and the test when one is set, before it asks you.</p>
    <p class="feedback" id="feedback-task" aria-live="polite"></p>
    <p class="hint">Gemini takes tasks when you type /wk-take-task in Antigravity, or from an automation you set up once.</p>
    <button type="button" class="btn btn-secondary" data-cmd="copyAutomation">Copy the automation prompt</button>
    <p class="feedback" id="feedback-copy" aria-live="polite"></p>
    <div class="slot" data-slot="routes"></div>
  </section>
  </details>
  <details class="ops-group" id="ops-skills" data-id="ops-skills" data-ops-group><summary>Skills</summary>
  <section id="sec-skills" aria-labelledby="h-skills" data-plugin-only="1" data-tab-group="skills" hidden>
    <h2 id="h-skills">Skills Library</h2>
    <div class="skills-bar">
      <input id="skills-search" type="search" maxlength="120" placeholder="Search skills (react, audit, mcp…)">
      <select id="skills-domain"><option value="">All domains</option></select>
      <button type="button" class="btn btn-secondary" data-cmd="skillsSync" title="Update the skills library from its sources">Sync skills</button>
    </div>
    <p class="feedback" id="feedback-skills" aria-live="polite"></p>
    <div class="slot" data-slot="skills"></div>
  </section>
  <section id="sec-review" aria-labelledby="h-review" data-plugin-only="1" hidden><h2 id="h-review">Library review</h2><div class="slot" data-slot="skillReview"></div>
    <p class="feedback" id="feedback-review" aria-live="polite"></p></section>
  </details>
  <details class="ops-group" id="ops-work" data-id="ops-work" data-ops-group><summary>Projects, spend and advice</summary>
  <section aria-labelledby="h-projects" data-needs="projects" hidden><h2 id="h-projects">Projects</h2><div class="slot" data-slot="projects"></div></section>
  <section aria-labelledby="h-spend" data-needs="plugin" hidden><h2 id="h-spend">Spend, last 7 days</h2><div class="slot" data-slot="spend"></div></section>
  <section aria-labelledby="h-advice" data-needs="plugin" hidden><h2 id="h-advice">Answered for you</h2><div class="slot" data-slot="advice"></div></section>
  </details>
  <details class="ops-group" id="ops-notes" data-id="ops-notes" data-ops-group><summary>Notes and messages</summary>
  <section aria-labelledby="h-inbox" data-needs="plugin" hidden><h2 id="h-inbox">Recommendations and rules</h2>
    <label for="note" class="label">Your note to the company</label>
    <textarea id="note" rows="4" maxlength="${D.MAX_TEXT}" aria-describedby="note-help note-count"></textarea>
    <p class="hint count" id="note-count" aria-hidden="true"></p>
    <div class="actions">
      <button type="button" class="btn" data-send="recommendation">Send as recommendation</button>
      <button type="button" class="btn btn-secondary" data-send="rule">Propose a rule change</button>
    </div>
    <p class="hint" id="note-help">A rule change is only saved, in <code>~/.wk/owner-inbox.jsonl</code>. No session reads it by itself: ask Claude Code to read that file, make the change, and approve it in that chat.</p>
    <p class="feedback" id="feedback" aria-live="polite"></p>
    <h3>Last 10 sent</h3>
    <div class="slot" data-slot="inbox"></div>
  </section>
  <section aria-labelledby="h-messages" data-plugin-only="1" hidden><h2 id="h-messages">Messages</h2><div class="slot" data-slot="messages"></div></section>
  </details>
  <details class="ops-group" id="ops-system" data-id="ops-system" data-ops-group><summary>Phone, updates and graph</summary>
  <section aria-labelledby="h-phone" data-needs="phone" hidden><h2 id="h-phone">Phone</h2><div class="slot" data-slot="phone"></div>
    <p class="feedback" id="feedback-phone" aria-live="polite"></p></section>
  <section aria-labelledby="h-version" data-needs="plugin" hidden><h2 id="h-version">Updates</h2><div class="slot" data-slot="version"></div></section>
  <section aria-labelledby="h-graph" data-plugin-only="1" hidden><h2 id="h-graph">Graph</h2><div class="slot" data-slot="graph"></div></section>
  </details>
  </div>
  <div class="wk-shell">
  <aside class="wk-rail" aria-label="Sessions" data-plugin-only="1" hidden>
    <div class="rail-top">
      <button type="button" class="btn btn-secondary btn-small rail-toggle" data-cmd="toggleRail" aria-expanded="true" aria-controls="wk-rail-body">Hide list</button>
      <button type="button" class="btn btn-small" data-cmd="chatNew">+ New Session</button>
    </div>
    <div id="wk-rail-body" class="rail-body">
      <div class="slot" data-slot="rail"></div>
      <details class="rail-limits" id="wk-limits" data-id="wk-limits"><summary><span class="slot" data-slot="limits">Limits</span></summary>
      <section aria-labelledby="h-usage" data-needs="plugin" hidden><h2 id="h-usage">Usage</h2><div class="slot" data-slot="usage"></div></section>
      <section aria-labelledby="h-pace" data-needs="plugin" hidden><h2 id="h-pace">This week</h2><div class="slot" data-slot="pace"></div></section>
      </details>
    </div>
  </aside>
  <div class="wk-canvas">
  <section id="sec-reprompt" aria-labelledby="h-reprompt" data-plugin-only="1" data-tab-group="reprompt" hidden>
    <h2 id="h-reprompt">Re-Prompt</h2>
    <div class="slot chat-thread" id="chat-thread" data-slot="chat">${renderChatThread()}</div>
    <textarea id="rp-output" rows="4" maxlength="${D.MAX_PROMPT}" hidden></textarea>
    <div class="chat-composer">
      <label class="label" for="rp-draft">Message</label>
      <textarea id="rp-draft" rows="3" maxlength="${D.MAX_PROMPT}" placeholder="Ask Watchkeeper anything…"></textarea>
      <div class="composer-bar">
        <button type="button" class="wk-pill wk-mode-pill" id="rp-mode-pill" data-cmd="toggleRpMode" aria-pressed="true" aria-label="Re-prompt before sending" title="On: Watchkeeper rewrites your message before sending (:re-prompt). Off: sent as typed (:raw).">:re-prompt</button>
        <span class="rp-chips" id="rp-skill-chips" aria-label="Pinned skills"></span>
        <div class="actions">
          <button type="button" class="btn" id="rp-send-btn" data-cmd="chatDraft">Send →</button>
          <button type="button" class="btn btn-secondary btn-small" data-cmd="repromptStudio">Studio</button>
        </div>
      </div>
      <p class="rail-note composer-note" data-composer-note role="status" aria-live="polite" hidden></p>
      <details class="composer-opts" data-id="composer-opts"><summary>Overrides</summary>
        <label class="route-pick"><span class="label-inline">Route</span><select id="rp-route"><option value="auto" selected>Auto (by quota)</option><option value="carbon">Gemini only (API key or queue)</option><option value="claude">Prefer Claude</option><option value="gemini">Prefer Gemini (API key or queue)</option></select></label>
        <label class="chk"><input type="checkbox" id="rp-confirm-go"> Confirm before Go</label>
        <label class="chk" title="On: prompts of more than 30 words are re-prompted. rp: always re-prompts; raw: never does."><input type="checkbox" id="rp-auto-mode" checked> Auto Re-Prompt</label>
        <label class="chk"><input type="checkbox" id="rp-sync-ide" checked> Paste into Antigravity's chat (not for Claude targets)</label>
        <label class="chk"><input type="checkbox" id="rp-auto-take"> Run queued tasks here with your Gemini API key</label>
        <div class="rp-row">
          <div><label class="label" for="rp-target">Target</label><select id="rp-target"><option value="auto" selected>Auto</option><option value="antigravity">Antigravity</option><option value="claude">Claude Code</option><option value="general">General</option></select></div>
          <div><label class="label" for="rp-mode">Mode</label><select id="rp-mode"><option value="auto" selected>Auto</option><option value="balanced">Balanced</option><option value="spec">Deep Spec</option><option value="bugfix">Bug Fix</option><option value="refactor">Refactor</option><option value="concise">Concise</option></select></div>
        </div>
        <label class="label" for="rp-skills">Pinned Skills (+skill:name / -skill:name)</label>
        <input id="rp-skills" type="text" maxlength="300" autocomplete="off" placeholder="+skill:react -skill:legacy">
        <div class="actions">
          <button type="button" class="btn btn-secondary btn-small" data-cmd="repromptRewrite">Preview Raw Re-Prompt</button>
          <button type="button" class="btn btn-secondary btn-small" data-cmd="repromptSend" data-target="antigravity">Paste into Antigravity's chat</button>
          <button type="button" class="btn btn-secondary btn-small" data-cmd="repromptSend" data-target="claude">Send Direct to Claude</button>
          <button type="button" class="btn btn-secondary btn-small" data-cmd="repromptCopy">Copy</button>
        </div>
      </details>
    </div>
    <p class="feedback" id="feedback-reprompt" aria-live="polite"></p>
  </section>
  <section aria-labelledby="h-about" data-needs="no-plugin" hidden><h2 id="h-about">About this panel</h2><div class="slot" data-slot="about"></div></section>
  </div>
  </div>
</main>
<script nonce="${esc(nonce)}" src="${esc(scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { renderBridge, BRIDGE_TONE, dagCard, renderChannel, renderChannelUpdate, statusLineText, renderUsage, resetLine, promptBadge, repromptDrawer, ICONS, geminiLabelOf, renderStatusBar, waitingCount, renderSkillReview, limitsLabel, isArchivedWk, graphBadgeText, renderJobs, renderProjects, renderPhone, renderOrchestrator, renderSkills, renderRail, renderChatThread, eventLine, isLocal, LOCAL_LINE, JOB_WORDS, renderWaiting, renderGemini, renderRoutes, expandable, sessionsOnly, renderAbout, esc, when, ago, span, pct, usd, tok, lockSince, reasonWords, status, paceSentence, renderStatus, renderPace, renderSpend, renderSessions, renderAdvice, renderUpdate, renderInbox, renderControls, renderSections, renderPage };
