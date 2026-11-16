'use strict';
// The W panel's HTML (P2-205). Pure functions: data in, escaped HTML out. Every string that came from a file goes through esc().
const D = require('./data');

const esc = v => String(v == null ? '' : v).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = n => String(n).padStart(2, '0');
const plural = (n, w, ws = w + 's') => `${n} ${n === 1 ? w : ws}`;

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

// P2-227: one code, two hosts. "antigravity" (the panel, the default) shows every control; "web" (the phone page on your server) leaves out
// what only the Mac may do, with one plain line instead.
const isLocal = m => ((m && m.host) || 'antigravity') === 'antigravity';
const LOCAL_LINE = 'Do this in the Watchkeeper panel on your Mac.';
const localLine = (lead = '') => `<p class="hint local-only">${esc(lead)}${esc(LOCAL_LINE)}</p>`;

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
  if (m.kill && m.kill.on) return { key: 'stopped', word: 'Stopped', note: 'The kill switch is on: no wake-ups run.' };
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
      + `<p class="hint">This removes <code>${f}</code> after you confirm.</p>`;
  }
  return `<p class="control-state">${SHAPES.running}Wake-ups are allowed.</p>`
    + `<button type="button" class="btn btn-secondary" data-cmd="kill">Stop all wake-ups</button>`
    + `<p class="hint">This creates <code>${f}</code>. While it exists, Claude sessions using the Watchkeeper plugin can only read: no writing, shell, web or MCP tools.</p>`;
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

function renderWaiting(m) {
  const q = m.questions || { items: [], hidden: 0 }, s = m.suggestions || { items: [] }, now = m.now;
  const qs = q.items || [], ss = s.items || [];
  const hiddenNote = q.hidden ? `<p class="hint">${esc(plural(q.hidden, 'question'))} hidden for 24 hours with Later.</p>` : '';
  if (!qs.length && !ss.length) return `<p class="empty">Nothing waits for you.</p>${hiddenNote}`;
  const list = (key, word, rows, row) => `<h3>${word} <span class="num count-n">${rows.length}</span></h3><ul class="rows waiting" data-list="${key}">`
    + rows.map((x, i) => row(x, i >= SHOWN)).join('') + `</ul>`
    + (rows.length > SHOWN ? `<button type="button" class="btn btn-secondary btn-small" data-cmd="showAll" data-list="${key}" aria-expanded="false">Show all ${rows.length}</button>` : '');
  return (qs.length ? list('q', 'Questions', qs, questionRow) : '') + hiddenNote
    + (ss.length ? list('s', 'Suggestions', ss, (x, extra) => suggestionRow(x, extra, now, isLocal(m))) : '');
}

// ---------------------------------------------------------------- P2-223: Gemini
const KIND_WORDS = { read: 'Read', quick: 'Quick', code: 'Code', ui: 'Screens', plan: 'Plan', hard: 'Hard', review: 'Review', legal: 'Legal' };
const KIND_FOR = { read: 'read, search and summarize, no edits', quick: 'small, clear jobs: renames, docs, small scripts, tests', code: 'a feature or fix in one area',
  ui: 'screens, layout and styles', plan: 'features across many files, refactors', hard: 'hard bugs, concurrency, migrations, architecture', review: 'a second opinion on a change, read-only',
  legal: 'legal wording, on the strongest model; the owner approves it before use' };
const TASK_WORDS = { queued: 'Waiting for Gemini', taken: 'Gemini is on it', verified: 'Checked: tests pass', failed: 'Checks failed', 'out-of-scope': 'Changed files outside its list',
  'no-change': 'No change made', merged: 'Merged', discarded: 'Set aside', conflict: 'Merge conflict: nothing merged', unknown: 'Unknown' };
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
        + `<span class="row-meta">${SHAPES[TASK_SHAPE[x.status] || 'unknown']}<span class="badge">${esc(x.status === 'verified' && x.hasTest === false ? 'Checked: files only, no test set' : TASK_WORDS[x.status] || 'Unknown')}</span> ${esc(meta)}</span>`
        + (x.note ? `<span class="row-meta clamp">${esc(x.note)}</span>` : '')
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
  unknown: 'Install Watchkeeper into Antigravity to set this.' };
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
  let html = jobForm(m);
  if (!js.length) return html + `<p class="hint">No jobs yet.</p>`;
  html += `<h3>Jobs</h3><ul class="rows jobs">` + js.map(j => {
    const id = esc(j.id), st = JOB_WORDS[j.state] ? j.state : 'failed';
    const meta = [j.project, j.legal ? D.legalLabel(j.model_id) : MODEL_WORDS[j.model] || j.model, D.MODE_WORDS[j.mode] || '', FROM_JOB[j.from] || '', j.started_at ? when(j.started_at, now) : '',
      typeof j.cost_usd === 'number' ? usd(j.cost_usd) : '', typeof j.turns === 'number' ? plural(j.turns, 'turn') : ''].filter(Boolean).join(' · ');
    const tail = local ? arr(j.tail).map(ev => { const t = eventLine(ev); return t ? `<li class="ev ev-${esc(String(ev.type || 'x').replace(/[^a-z_]/g, ''))}">${esc(t)}</li>` : ''; }).join('') : '';
    return `<li class="job" data-job-item="${id}"><details data-job="${id}" data-id="job-${id}">`
      + `<summary>${SHAPES[JOB_SHAPE[st]]}<span class="badge">${esc(JOB_WORDS[st])}</span> <span class="job-title">${esc(j.title || j.id)}</span></summary>`
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
  if (noServer) html += `<p class="hint">Phone control needs a companion server, which is not published yet. If you run one, set it with <code>node &lt;plugin&gt;/bin/wk-bridge.mjs config</code>; the switch shows here after that.</p>`;
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

// The web host's status: the Mac, the stop switch and the limits, in one place
function webStatus(m) {
  const mac = m.mac || {}, r = m.remote || {};
  const macLine = mac.name ? `<p class="hint">${esc(mac.name)}${typeof mac.free_mb === 'number' ? ` · ${esc(mac.free_mb.toLocaleString('en-GB'))} MB free` : ''}${mac.low_ram ? ' · low on memory: new jobs wait' : ''}</p>` : '';
  const limits = Number.isFinite(r.max_jobs) ? `<p class="hint">At most ${esc(plural(r.max_jobs, 'job'))} at once, each up to ${esc(plural(r.job_hours, 'hour'))}; new jobs wait when the week's use reaches ${esc(r.pace_stop_pct)}%.</p>` : '';
  return renderStatus(m) + macLine + renderControls(m) + limits;
}
function renderAboutWeb(m) {
  const b = m.bridge || {};
  return `<p class="hint">This page shows what Watchkeeper on your Mac sent${b.pushed_at ? ` (last at ${esc(when(b.pushed_at, m.now))})` : ''}. The Mac checks every press: it acts only on commands signed with a phone key you trusted on the Mac, and only while phone control is on.</p>`
    + `<p class="hint">No code comes from this page to the Mac, and no file goes from the Mac without a scan for secrets first.${b.version ? ` Watchkeeper ${esc(b.version)}.` : ''}</p>`;
}

// Without the Watchkeeper plugin the panel shows only what works for any Claude Code user; the plugin's sections stay hidden.
const sessionsOnly = m => !!(m.pace && m.pace.state === 'no-plugin');
function renderAbout(m) {
  const home = m.paths && m.paths.home, c = esc(tilde((m.paths && m.paths.claudeDir) || '~/.claude', home));
  return `<p class="hint">This panel reads the Claude Code session files in <code>${c}/projects</code> on this computer and checks whether the Watchkeeper plugin is set up. It makes no network calls and writes nothing.</p>`
    + `<p class="hint">A session is active when it wrote in the last 10 minutes. A worker is a sub-agent that a session started. The token count is an estimate of the transcript's length, not of what the session used.</p>`
    + `<p class="hint">Install the free Watchkeeper plugin for Claude Code to add questions and suggestions with one-press answers, jobs you start from here, spend, the Gemini queue and a switch that stops unattended work. In Claude Code, type: <code>/plugin install watchkeeper --marketplace tengotengo23/nexodyne-watchkeeper</code> (before Claude Code 2.1.275, two lines: <code>/plugin marketplace add tengotengo23/nexodyne-watchkeeper</code> and <code>/plugin install watchkeeper@nexodyne</code>). The panel then finds the plugin by itself; set <code>watchkeeper.pluginPath</code> in Settings only for a copy kept somewhere else.</p>`;
}

// An untrusted folder: the buttons that run a program are off (media/main.js), and this line says why.
const UNTRUSTED_NOTE = '<p class="hint" data-untrusted="1">This folder is not trusted, so the buttons that run something are off here: answering, deciding, adding a task, jobs and the phone. Trust the folder (Manage Workspace Trust) to use them.</p>';
function renderSections(m, open) {
  const lite = sessionsOnly(m), local = isLocal(m), untrusted = local && !lite && m.untrusted === true;
  return { mode: lite ? 'sessions' : 'full', untrusted, about: local ? renderAbout(m) : renderAboutWeb(m), status: (local ? renderStatus(m) : webStatus(m)) + (untrusted ? UNTRUSTED_NOTE : ''), pace: renderPace(m), spend: renderSpend(m), sessions: renderSessions(m, open), advice: renderAdvice(m), inbox: renderInbox(m), controls: renderControls(m), version: renderUpdate(m),
    updated: `Updated ${when(m.now, m.now).replace('today ', '')}`,
    // P2-223: the new sections (data-needs="waiting" and "gemini") show only with the plugin
    waiting: lite ? '' : renderWaiting(m), gemini: lite ? '' : renderGemini(m), routes: lite ? '' : renderRoutes(m),
    // P2-227: jobs, projects and the phone (data-needs "jobs", "projects", "phone"), also only with the plugin
    jobs: lite ? '' : renderJobs(m), projects: lite ? '' : renderProjects(m), phone: lite ? '' : renderPhone(m),
    show: { waiting: !lite, gemini: !lite, jobs: !lite, projects: !lite, phone: !lite } };
}

function renderPage({ nonce, cspSource, styleUris = [], scriptUri, bodyClass = '' }) {
  const csp = `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; font-src ${cspSource}; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp.replace(/[&<>"]/g, '')}">
<meta name="viewport" content="width=device-width, initial-scale=1">
${styleUris.map(u => `<link rel="stylesheet" href="${esc(u)}">`).join('\n')}
<title>Watchkeeper</title>
</head>
<body${bodyClass ? ` class="${esc(bodyClass)}"` : ''}>
<main>
  <header class="top">
    <div class="slot" data-slot="status"><p class="status status-unknown">${SHAPES.unknown}<span class="status-word">Reading…</span></p></div>
    <div class="top-actions"><button type="button" class="btn btn-secondary btn-small" data-cmd="refresh">Refresh</button>
    <span class="updated slot" data-slot="updated"></span></div>
  </header>
  <section aria-labelledby="h-waiting" data-needs="waiting" hidden><h2 id="h-waiting">Waiting for you</h2><div class="slot" data-slot="waiting"></div>
    <p class="feedback" id="feedback-waiting" aria-live="polite"></p></section>
  <section aria-labelledby="h-pace" data-needs="plugin" hidden><h2 id="h-pace">This week</h2><div class="slot" data-slot="pace"></div></section>
  <section aria-labelledby="h-jobs" data-needs="jobs" hidden><h2 id="h-jobs">Jobs</h2><div class="slot" data-slot="jobs"></div>
    <p class="feedback" id="feedback-jobs" aria-live="polite"></p></section>
  <section aria-labelledby="h-projects" data-needs="projects" hidden><h2 id="h-projects">Projects</h2><div class="slot" data-slot="projects"></div></section>
  <section aria-labelledby="h-sessions"><h2 id="h-sessions">Sessions and workers</h2><div class="slot" data-slot="sessions"></div></section>
  <section aria-labelledby="h-spend" data-needs="plugin" hidden><h2 id="h-spend">Spend, last 7 days</h2><div class="slot" data-slot="spend"></div></section>
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
  <section aria-labelledby="h-advice" data-needs="plugin" hidden><h2 id="h-advice">Answered for you</h2><div class="slot" data-slot="advice"></div></section>
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
  <section aria-labelledby="h-controls" data-needs="plugin" hidden><h2 id="h-controls">Wake-up switch</h2><div class="slot" data-slot="controls"></div></section>
  <section aria-labelledby="h-phone" data-needs="phone" hidden><h2 id="h-phone">Phone</h2><div class="slot" data-slot="phone"></div>
    <p class="feedback" id="feedback-phone" aria-live="polite"></p></section>
  <section aria-labelledby="h-version" data-needs="plugin" hidden><h2 id="h-version">Updates</h2><div class="slot" data-slot="version"></div></section>
  <section aria-labelledby="h-about" data-needs="no-plugin" hidden><h2 id="h-about">About this panel</h2><div class="slot" data-slot="about"></div></section>
</main>
<script nonce="${esc(nonce)}" src="${esc(scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { renderJobs, renderProjects, renderPhone, eventLine, isLocal, LOCAL_LINE, JOB_WORDS, renderWaiting, renderGemini, renderRoutes, expandable, sessionsOnly, renderAbout, esc, when, ago, span, pct, usd, tok, lockSince, reasonWords, status, paceSentence, renderStatus, renderPace, renderSpend, renderSessions, renderAdvice, renderUpdate, renderInbox, renderControls, renderSections, renderPage };
