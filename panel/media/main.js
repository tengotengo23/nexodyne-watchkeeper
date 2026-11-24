// The W panel's webview script (P2-205). It only shows what the extension sends and posts known commands back.
// P2-223: "Waiting for you" (answer a question, decide a suggestion) and Gemini (hand a task, copy the automation prompt).
// P2-227: jobs (start, reply, stop) and the phone (trust or reject a key, phone control on and off). Forms inside a slot keep
// what was typed across a refresh (state.fields).
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const MAX = 4000, MAX_TITLE = 200, CONFIRM_MS = 8000;
  let state = vscode.getState() || {};
  if (typeof state !== 'object' || state === null) state = {};
  const obj = v => (v && typeof v === 'object' ? v : {});
  const isFullIde = document.body.classList.contains('wk-full-ide');
  state.open = obj(state.open);
  state.draft = typeof state.draft === 'string' ? state.draft : '';
  state.answers = obj(state.answers);     // question number -> draft text, while its answer box is open
  state.more = obj(state.more);           // expanded "More" texts
  state.showAll = obj(state.showAll);     // "Show all N" per list
  state.task = obj(state.task);           // the task form's draft
  state.fields = obj(state.fields);       // P2-227: drafts of the job form and the reply boxes, by element id
  state.rp = obj(state.rp);               // v0.8.0: active Re-Prompt draft/output
  if (typeof state.tab !== 'string' || !['reprompt', 'tasks', 'skills', 'overview', 'all'].includes(state.tab)) {
    state.tab = isFullIde ? 'reprompt' : 'all';
  }
  const MAX_PROMPT = 8000;
  const KEEP = /^(job-(project|prompt|model|mode|turns)|reply-J-\d{8}-\d{4}-[0-9a-f]{4})$/;
  const save = () => vscode.setState(state);

  const note = document.getElementById('note');
  const count = document.getElementById('note-count');
  const feedback = document.getElementById('feedback');
  const taskTitle = document.getElementById('task-title'), taskText = document.getElementById('task-text'), taskKind = document.getElementById('task-kind'), taskTest = document.getElementById('task-test');
  const rpTarget = document.getElementById('rp-target'), rpMode = document.getElementById('rp-mode'), rpRoute = document.getElementById('rp-route'), rpSkills = document.getElementById('rp-skills'), rpDraft = document.getElementById('rp-draft'), rpOutput = document.getElementById('rp-output');
  const rpConfirmGo = document.getElementById('rp-confirm-go'), rpAutoMode = document.getElementById('rp-auto-mode'), rpSyncIde = document.getElementById('rp-sync-ide'), rpAutoTake = document.getElementById('rp-auto-take');
  const chatThread = document.getElementById('chat-thread');
  const orchPrompt = document.getElementById('orch-prompt'), orchPrefer = document.getElementById('orch-prefer'), orchOutput = document.getElementById('orch-output');
  const skillsSearch = document.getElementById('skills-search'), skillsDomain = document.getElementById('skills-domain');
  const last = {};
  const confirmDrafts = {};
  const merging = {};                     // suggestion id -> true while its merge runs
  const armed = {};                       // money confirm: key -> timer
  let diffWhere = 'gemini';
  let activeChatSessionId = null;

  const TAB_BY_HEADING = {
    'h-reprompt': 'reprompt',
    'h-orchestrator': 'tasks',
    'h-jobs': 'tasks',
    'h-sessions': 'tasks',
    'h-gemini': 'tasks',
    'h-skills': 'skills',
    'h-waiting': 'overview',
    'h-pace': 'overview',
    'h-projects': 'overview',
    'h-spend': 'overview',
    'h-advice': 'overview',
    'h-inbox': 'overview',
    'h-controls': 'overview',
    'h-phone': 'overview',
    'h-version': 'overview',
    'h-about': 'overview',
  };

  // P2-272 phase 3: no tabs any more; every section shows in one stream. A "tab" now only brings its
  // section into view (the host still sends switchTab when it opens the panel on a given area).
  const TAB_TARGET = { reprompt: 'sec-reprompt', tasks: 'sec-orchestrator', orchestrator: 'sec-orchestrator', skills: 'sec-skills' };
  function applyTab(tab, scroll) {
    state.tab = ['reprompt', 'tasks', 'skills', 'overview', 'all'].includes(tab) ? tab : (isFullIde ? 'reprompt' : 'all');
    document.querySelectorAll('.tab-off').forEach(sec => sec.classList.remove('tab-off'));
    const id = TAB_TARGET[tab] || '';
    if (tab === 'overview' && document.querySelector('.wk-pill[data-cmd="toggleWaiting"]')) setUi('waiting', true);
    const el = id && document.getElementById(id);
    if (scroll && el && !el.hidden) revealIn(el);
    save();
  }
  // S1: a section inside the drawer is in a closed group; open the drawer and that group, then scroll to it
  function revealIn(el) {
    const ops = document.getElementById('wk-ops');
    if (ops && ops.contains(el) && !liteMode) {
      if (state.ui.ops !== true) setUi('ops', true);
      const g = el.closest('details[data-id]');
      if (g && !g.open) { g.open = true; state.open[g.getAttribute('data-id')] = true; save(); }
    }
    if (el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  // ------------------------------------------------ the frame: waiting panel, Ops drawer, rail (inline, no overlay)
  state.ui = obj(state.ui);
  let liteMode = false;
  const UI = { waiting: 'wk-waiting-panel', ops: 'wk-ops', rail: 'wk-rail-body' };
  const UI_CMD = { waiting: 'toggleWaiting', ops: 'toggleOps', rail: 'toggleRail' };
  function syncUi() {
    for (const k of Object.keys(UI)) {
      const el = document.getElementById(UI[k]); if (!el) continue;
      const on = k === 'rail' ? state.ui.rail !== false : state.ui[k] === true && !(k === 'ops' && liteMode);
      el.hidden = !on;
      document.querySelectorAll(`[data-cmd="${UI_CMD[k]}"]`).forEach(b => b.setAttribute('aria-expanded', on ? 'true' : 'false'));
    }
    document.querySelectorAll('[data-cmd="toggleRail"]').forEach(b => { b.textContent = state.ui.rail !== false ? 'Hide list' : 'Show list'; });
    const shell = document.querySelector('.wk-shell'); if (shell) shell.classList.toggle('rail-closed', state.ui.rail === false);
  }
  function setUi(k, on) {
    state.ui[k] = on; save(); syncUi();
    const el = document.getElementById(UI[k]);
    if (on && el && k !== 'rail') { fade(el); const h = el.querySelector('h2, .wk-drawer-title'); if (h && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'auto' }); }
  }
  syncUi();
  applyTab(state.tab);

  // Without the plugin the drawer stays closed, so the Claude Code sessions list moves into the canvas
  function placeSessions(lite) {
    const sec = document.getElementById('sec-sessions'); if (!sec) return;
    const about = document.querySelector('.wk-canvas > section[data-needs="no-plugin"]'), group = document.getElementById('ops-tasks');
    if (lite && about && sec.parentNode !== about.parentNode) about.parentNode.insertBefore(sec, about);
    else if (!lite && group && sec.parentNode !== group) group.appendChild(sec);
  }

  // M1/M2: a refusal or a failure for one session shows under its row (or under the composer for /done)
  const rowNotes = {};
  function showNote(sid, text, where) {
    let p = where === 'composer' ? null : q('[data-row-note]' + attr('data-row-note', sid));
    if (!p) p = q('[data-composer-note]');
    if (!p) return;
    p.textContent = text; p.hidden = !text; p.classList.toggle('wait-msg-error', !!text);
    if (text) fade(p);
  }
  function applyRowNotes() { for (const sid of Object.keys(rowNotes)) showNote(sid, rowNotes[sid].text, rowNotes[sid].where); }
  function clearRowNote(sid) {
    if (!rowNotes[sid]) return;
    const where = rowNotes[sid].where; delete rowNotes[sid];
    showNote(sid, '', where);
  }

  // Enter sends, Shift+Enter makes a new line, in every composer (IME composition is left alone)
  function enterSends(e) {
    return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing && e.keyCode !== 229;
  }
  const ENTER_SENDS = [
    [t => t.id === 'note', () => q('[data-send="recommendation"]')],
    [t => t.id === 'task-text', () => q('button[data-cmd="addTask"]')],
    [t => t.id === 'orch-prompt', () => q('button[data-cmd="orchestrateRun"]')],
    [t => t.id === 'job-prompt', () => q('button[data-cmd="jobStart"]')],
    [t => /^ans-text-/.test(t.id || ''), t => { const box = t.closest('li, form, div'); return box && box.querySelector('button[data-cmd="sendAnswer"]'); }],
    [t => t.hasAttribute('data-reply'), t => { const box = t.closest('li, form, div'); return box && box.querySelector('button[data-cmd="jobReply"]'); }],
  ];
  document.addEventListener('keydown', e => {
    const t = e.target;
    if (!t || t.tagName !== 'TEXTAREA' || t === rpDraft || !enterSends(e)) return;
    for (const [match, find] of ENTER_SENDS) {
      if (!match(t)) continue;
      const btn = find(t);
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
      return;
    }
  });

  // the :re-prompt / :raw pill mirrors the "Re-Prompt first" checkbox; skill chips mirror the skills box
  const rpModePill = document.getElementById('rp-mode-pill'), rpChips = document.getElementById('rp-skill-chips');
  function syncModePill() {
    if (!rpModePill || !rpAutoMode) return;
    const on = rpAutoMode.checked;
    rpModePill.textContent = on ? ':re-prompt' : ':raw';
    rpModePill.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function syncChips() {
    if (!rpChips || !rpSkills) return;
    rpChips.textContent = '';
    const toks = rpSkills.value.split(/\s+/).filter(Boolean);
    for (const tok of toks) {
      const chip = document.createElement('span'); chip.className = 'rp-chip';
      const label = document.createElement('span'); label.textContent = tok;
      const x = document.createElement('button'); x.type = 'button'; x.className = 'rp-chip-x';
      x.setAttribute('data-cmd', 'rpChipRemove'); x.setAttribute('data-tok', tok);
      x.setAttribute('aria-label', 'Remove ' + tok); x.textContent = '×';
      chip.append(label, x); rpChips.append(chip);
    }
  }

  if (rpDraft) {
    rpDraft.value = typeof state.rp.draft === 'string' ? state.rp.draft : '';
    if (rpOutput) rpOutput.value = typeof state.rp.output === 'string' ? state.rp.output : '';
    if (rpSkills && typeof state.rp.skills === 'string') rpSkills.value = state.rp.skills;
    if (rpTarget && typeof state.rp.target === 'string' && [...rpTarget.options].some(o => o.value === state.rp.target)) rpTarget.value = state.rp.target;
    if (rpMode && typeof state.rp.mode === 'string' && [...rpMode.options].some(o => o.value === state.rp.mode)) rpMode.value = state.rp.mode;
    if (rpRoute && typeof state.rp.route === 'string' && [...rpRoute.options].some(o => o.value === state.rp.route)) rpRoute.value = state.rp.route;
    if (rpConfirmGo && typeof state.rp.confirmGo === 'boolean') rpConfirmGo.checked = state.rp.confirmGo;
    if (rpAutoMode && typeof state.rp.autoMode === 'boolean') rpAutoMode.checked = state.rp.autoMode;
    if (rpSyncIde && typeof state.rp.syncToIde === 'boolean') rpSyncIde.checked = state.rp.syncToIde;
    const keepRp = () => {
      state.rp = {
        draft: rpDraft.value,
        output: rpOutput ? rpOutput.value : '',
        skills: rpSkills ? rpSkills.value : '',
        target: rpTarget ? rpTarget.value : 'auto',
        mode: rpMode ? rpMode.value : 'auto',
        route: rpRoute ? rpRoute.value : 'auto',
        confirmGo: rpConfirmGo ? rpConfirmGo.checked : true,
        autoMode: rpAutoMode ? rpAutoMode.checked : true,
        syncToIde: rpSyncIde ? rpSyncIde.checked : true,
      };
      save();
    };
    [rpDraft, rpOutput, rpSkills].forEach(el => el && el.addEventListener('input', keepRp));
    [rpTarget, rpMode, rpRoute, rpConfirmGo, rpAutoMode, rpSyncIde].forEach(el => el && el.addEventListener('change', keepRp));
    if (rpConfirmGo) rpConfirmGo.addEventListener('change', () => vscode.postMessage({ cmd: 'chatToggleConfirm', enabled: rpConfirmGo.checked }));
    if (rpSyncIde) rpSyncIde.addEventListener('change', () => vscode.postMessage({ cmd: 'chatToggleSyncIde', enabled: rpSyncIde.checked }));
    if (rpAutoTake) rpAutoTake.addEventListener('change', () => vscode.postMessage({ cmd: 'chatToggleAutoTake', enabled: rpAutoTake.checked }));
    if (rpAutoMode) rpAutoMode.addEventListener('change', syncModePill);
    if (rpSkills) rpSkills.addEventListener('input', syncChips);
    syncModePill(); syncChips();
    rpDraft.addEventListener('keydown', e => {
      if (enterSends(e)) {
        e.preventDefault();
        sendChatDraft();
      }
    });
  }

  function sendChatDraft() {
    const prompt = rpDraft ? rpDraft.value.trim() : '';
    if (!prompt) { say('Write a message first.', false, 'reprompt'); if (rpDraft) rpDraft.focus(); return; }
    if (prompt.length > MAX_PROMPT) { say('That is over 8,000 characters. Please shorten it.', false, 'reprompt'); return; }
    rpDraft.value = '';
    state.rp.draft = ''; save();
    say('Preparing Graphify context, auto skills, target/mode & re-prompt…', true, 'reprompt');
    vscode.postMessage({
      cmd: 'chatDraft',
      sessionId: activeChatSessionId || '',
      prompt,
      target: rpTarget ? rpTarget.value : 'auto',
      mode: rpMode ? rpMode.value : 'auto',
      route: rpRoute ? rpRoute.value : 'auto',
      skills: rpSkills ? rpSkills.value.trim() : '',
      confirmBeforeGo: rpConfirmGo ? rpConfirmGo.checked : false,
      syncToIde: rpSyncIde ? rpSyncIde.checked : true,
      autoReprompt: rpAutoMode ? rpAutoMode.checked : true,
    });
  }

  function captureConfirmDrafts(root) {
    if (!root) return;
    root.querySelectorAll('[data-confirm-card]').forEach(card => {
      const tid = card.getAttribute('data-confirm-card');
      const specEl = document.getElementById('confirm-spec-' + tid);
      const tEl = document.getElementById('confirm-target-' + tid);
      const mEl = document.getElementById('confirm-mode-' + tid);
      const rEl = document.getElementById('confirm-route-' + tid);
      const sEl = document.getElementById('confirm-skills-' + tid);
      const prev = confirmDrafts[tid] || {};
      if (tid && (specEl || tEl || mEl || rEl || sEl)) {
        confirmDrafts[tid] = {
          spec: specEl ? specEl.value : '',
          target: tEl ? tEl.value : 'auto',
          mode: mEl ? mEl.value : 'auto',
          route: rEl ? rEl.value : 'auto',
          skills: sEl ? sEl.value : '',
          droppedSkills: Array.isArray(prev.droppedSkills) ? [...prev.droppedSkills] : [],
        };
      }
    });
  }

  function restoreConfirmDrafts(root) {
    if (!root) return;
    for (const [tid, d] of Object.entries(confirmDrafts)) {
      const card = root.querySelector('[data-confirm-card="' + tid + '"]');
      if (!card) continue;
      const specEl = document.getElementById('confirm-spec-' + tid);
      const tEl = document.getElementById('confirm-target-' + tid);
      const mEl = document.getElementById('confirm-mode-' + tid);
      const rEl = document.getElementById('confirm-route-' + tid);
      const sEl = document.getElementById('confirm-skills-' + tid);
      if (specEl && typeof d.spec === 'string') specEl.value = d.spec;
      if (tEl && d.target) tEl.value = d.target;
      if (mEl && d.mode) mEl.value = d.mode;
      if (rEl && d.route) rEl.value = d.route;
      if (sEl && typeof d.skills === 'string') sEl.value = d.skills;
      if (Array.isArray(d.droppedSkills) && d.droppedSkills.length) {
        const droppedSet = new Set(d.droppedSkills.map(x => String(x).toLowerCase()));
        card.querySelectorAll('[data-cmd="chatDropSkill"]').forEach(btn => {
          const sk = (btn.getAttribute('data-skill') || '').toLowerCase();
          if (droppedSet.has(sk)) {
            const chip = btn.closest('.skill-chip');
            if (chip) chip.remove();
          }
        });
      }
    }
  }

  let dagFocus = null;  // S13: { ids: [...], tries } set by a plan-card click
  const DAG_NEXT = {
    dagRun: ['stop'], dagCheck: ['stop', 'msg'], dagStop: ['msg', 'run'],
    dagMerge: ['msg'], dagMergeNo: ['msg'], dagNotNow: ['msg'],
  };
  function applyChatHtml(html) {
    if (!chatThread || typeof html !== 'string' || last.chat === html) return;
    const nearBottom = (chatThread.scrollHeight - chatThread.scrollTop - chatThread.clientHeight) < 80;
    const prevTop = chatThread.scrollTop;
    const focused = chatThread.contains(document.activeElement) ? document.activeElement.id : null;
    captureConfirmDrafts(chatThread);
    last.chat = html;
    chatThread.innerHTML = html;
    restoreConfirmDrafts(chatThread);
    // S13: after a plan-card click, focus goes to the next useful control once it exists (a few redraws at most).
    let moved = false;
    if (dagFocus) {
      const f = dagFocus.ids.map(id => document.getElementById(id)).find(el => el && !el.disabled);
      if (f) { f.focus(); moved = true; dagFocus = null; } else if (--dagFocus.tries <= 0) dagFocus = null;
    }
    if (!moved && focused) { const f = document.getElementById(focused); if (f) f.focus(); }
    chatThread.scrollTop = nearBottom ? chatThread.scrollHeight : prevTop;
  }

  function filterSkills() {
    const qText = (skillsSearch ? skillsSearch.value : '').trim().toLowerCase();
    const dom = skillsDomain ? skillsDomain.value : '';
    document.querySelectorAll('.skill-card').forEach(card => {
      const cDom = card.getAttribute('data-skill-domain') || '';
      const cQ = card.getAttribute('data-skill-q') || '';
      const okDom = !dom || cDom === dom;
      const okQ = !qText || cQ.includes(qText);
      card.hidden = !(okDom && okQ);
    });
  }
  if (skillsSearch) skillsSearch.addEventListener('input', filterSkills);
  if (skillsDomain) skillsDomain.addEventListener('change', filterSkills);

  function showCount() {
    const n = note.value.length;
    count.textContent = n ? `${n.toLocaleString('en-GB')} of ${MAX.toLocaleString('en-GB')} characters` : '';
  }
  note.value = state.draft;
  showCount();
  note.addEventListener('input', () => { state.draft = note.value; save(); showCount(); });

  if (taskTitle) {
    taskTitle.value = typeof state.task.title === 'string' ? state.task.title : '';
    taskText.value = typeof state.task.text === 'string' ? state.task.text : '';
    if (typeof state.task.kind === 'string' && [...taskKind.options].some(o => o.value === state.task.kind)) taskKind.value = state.task.kind;
    if (taskTest) taskTest.value = typeof state.task.test === 'string' ? state.task.test : '';
    const keep = () => { state.task = { title: taskTitle.value, text: taskText.value, kind: taskKind.value, test: taskTest ? taskTest.value : '' }; save(); };
    if (taskTest) taskTest.addEventListener('input', keep);
    taskTitle.addEventListener('input', keep); taskText.addEventListener('input', keep); taskKind.addEventListener('change', keep);
  }

  const fade = el => { el.classList.remove('fade'); void el.offsetWidth; el.classList.add('fade'); };
  function say(text, ok, where) {
    const el = (where && document.getElementById('feedback-' + where)) || feedback;
    el.textContent = text;
    el.classList.toggle('feedback-error', !ok);
    fade(el);
  }
  const q = sel => document.querySelector(sel);
  const attr = (name, v) => `[${name}="${CSS.escape(String(v))}"]`;

  function applyOpen(root) {
    root.querySelectorAll('details[data-id]').forEach(d => {
      const id = d.getAttribute('data-id');
      if (Object.prototype.hasOwnProperty.call(state.open, id)) d.open = !!state.open[id];
    });
  }
  applyOpen(document);
  document.addEventListener('toggle', e => {
    const d = e.target;
    if (d && d.tagName === 'DETAILS' && d.hasAttribute('data-id')) { state.open[d.getAttribute('data-id')] = d.open; save(); }
  }, true);

  // ------------------------------------------------ "Waiting for you": what the owner opened survives a refresh
  function setMore(btn, on) {
    const p = btn.closest('.wait-text'); if (!p) return;
    const rest = p.querySelector('.more-rest'), ell = p.querySelector('.ell');
    if (rest) rest.hidden = !on;
    if (ell) ell.hidden = on;
    btn.textContent = on ? 'Less' : 'More';
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  function setShowAll(btn, on) {
    const key = btn.getAttribute('data-list'), list = q('ul' + attr('data-list', key)); if (!list) return;
    list.querySelectorAll('.wait-extra').forEach(li => { li.hidden = !on; });
    btn.textContent = on ? 'Show fewer' : `Show all ${list.children.length}`;
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  function setAnswer(n, on, focus) {
    const box = document.getElementById('ans-' + n); if (!box) return;
    box.hidden = !on;
    const b = q('[data-cmd="openAnswer"]' + attr('data-n', n)); if (b) b.setAttribute('aria-expanded', on ? 'true' : 'false');
    const ta = box.querySelector('textarea');
    if (on) {
      if (typeof state.answers[n] === 'string') ta.value = state.answers[n]; else state.answers[n] = ta.value;
      const li = box.closest('li.wait'); if (li) li.hidden = false;
      fade(box);
      if (focus) ta.focus();
    } else { delete state.answers[n]; ta.value = ''; }
    save();
  }
  function setArmed(key, on) {
    const n = q('[data-confirm]' + attr('data-confirm', key));
    if (on) {
      clearTimeout(armed[key]);
      armed[key] = setTimeout(() => setArmed(key, false), CONFIRM_MS);
      if (n) { n.hidden = false; fade(n); }
    } else {
      clearTimeout(armed[key]); delete armed[key];
      if (n) n.hidden = true;
    }
  }
  // While a merge runs the buttons of that suggestion show "Merging…" and are disabled; a refresh keeps that, the answer lifts it.
  function setMerging(id, on) {
    if (on) merging[id] = true; else delete merging[id];
    const li = q('li.wait' + attr('data-s', id)); if (!li) return;
    li.querySelectorAll('button[data-cmd]').forEach(b => {
      b.disabled = !!on;
      if (b.hasAttribute('data-merge')) {
        if (!b.hasAttribute('data-label')) b.setAttribute('data-label', b.textContent);
        b.textContent = on ? 'Merging…' : b.getAttribute('data-label');
      }
    });
    li.setAttribute('aria-busy', on ? 'true' : 'false');
  }
  // P2-227: put back what was typed in a re-drawn form, and the focus
  function restoreFields(root) {
    root.querySelectorAll('input[id], textarea[id], select[id]').forEach(f => {
      if (!KEEP.test(f.id) || typeof state.fields[f.id] !== 'string') return;
      if (f.tagName === 'SELECT' && ![...f.options].some(o => o.value === state.fields[f.id])) return;
      f.value = state.fields[f.id];
    });
    for (const id of Object.keys(state.fields)) if (/^reply-/.test(id) && !document.getElementById(id)) delete state.fields[id];
  }
  const keepField = t => { if (t && t.id && KEEP.test(t.id)) { state.fields[t.id] = t.value; save(); } };
  document.addEventListener('change', e => keepField(e.target));

  function restoreWaiting(root) {
    for (const id of Object.keys(merging)) setMerging(id, true);
    root.querySelectorAll('[data-cmd="more"]').forEach(b => { if (state.more[b.getAttribute('data-key')]) setMore(b, true); });
    root.querySelectorAll('[data-cmd="showAll"]').forEach(b => { if (state.showAll[b.getAttribute('data-list')]) setShowAll(b, true); });
    for (const n of Object.keys(state.answers)) { if (document.getElementById('ans-' + n)) setAnswer(n, true, false); else delete state.answers[n]; }
    for (const key of Object.keys(armed)) { const n = q('[data-confirm]' + attr('data-confirm', key)); if (n) n.hidden = false; }
    save();
  }
  document.addEventListener('input', e => {
    const t = e.target;
    if (t && t.hasAttribute && t.hasAttribute('data-answer')) { state.answers[t.getAttribute('data-answer')] = t.value; save(); }
    keepField(t);
  });

  const RUNS = /^(okQuestion|sendAnswer|decide|removal|installAsk|jobStart|jobReply|jobStop|watchdogScan|watchdogRecover|trustKey|rejectKey|remoteOn|remoteOff|addTask|repromptRewrite|repromptSend|orchestrateRun|skillsSync|graphRefresh|chatDraft|chatConfirm|chatSendToIde|chatContinueFromClaude|chatTakeTask|chatHandoffToClaude|skillApprove|skillReject|dagRun|dagStop|dagMerge|dagCheck)$/;
  window.addEventListener('message', e => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'data' && m.sections && typeof m.sections === 'object') {
      document.querySelectorAll('[data-slot]').forEach(el => {
        const k = el.getAttribute('data-slot'), html = m.sections[k];
        if (typeof html !== 'string' || last[k] === html) return;
        if (k === 'chat') { applyChatHtml(html); return; }
        // an answer being typed is never thrown away by a refresh: its box is rebuilt with the draft
        const typing = k === 'waiting' && el.contains(document.activeElement) && document.activeElement.hasAttribute('data-answer') ? document.activeElement.getAttribute('data-answer') : null;
        const focused = el.contains(document.activeElement) && document.activeElement.id && KEEP.test(document.activeElement.id) ? document.activeElement.id : null;
        last[k] = html;
        el.innerHTML = html;
        applyOpen(el);
        restoreFields(el);
        if (focused) { const f = document.getElementById(focused); if (f) f.focus(); }
        if (k === 'waiting') { restoreWaiting(el); if (typing) { const ta = document.getElementById('ans-text-' + typing); if (ta) ta.focus(); } }
        if (k === 'skills') filterSkills();
        if (k === 'rail') applyRowNotes();
        if (k !== 'updated') fade(el);
      });
      const gb = document.getElementById('graph-badge');
      if (gb) document.querySelectorAll('[data-graph-copy]').forEach(el => { el.textContent = gb.textContent; });
      if (skillsDomain && Array.isArray(m.sections.skillDomains)) {
        const prev = skillsDomain.value;
        const want = [''].concat(m.sections.skillDomains);
        const cur = [...skillsDomain.options].map(o => o.value);
        if (JSON.stringify(cur) !== JSON.stringify(want)) {
          skillsDomain.innerHTML = '';
          const allOpt = document.createElement('option'); allOpt.value = ''; allOpt.textContent = 'All domains'; skillsDomain.appendChild(allOpt);
          m.sections.skillDomains.forEach(d => { const opt = document.createElement('option'); opt.value = d; opt.textContent = d; skillsDomain.appendChild(opt); });
          if (want.includes(prev)) skillsDomain.value = prev;
        }
      }
      // without the Watchkeeper plugin only the sessions and the about note show; the new sections follow `show`
      const lite = m.sections.mode === 'sessions', show = obj(m.sections.show);
      document.querySelectorAll('[data-needs]').forEach(s => {
        const need = s.getAttribute('data-needs');
        s.hidden = need === 'no-plugin' ? !lite : need === 'plugin' ? lite : (lite || !show[need]);
      });
      document.querySelectorAll('[data-plugin-only]').forEach(s => { s.hidden = lite; });
      liteMode = lite;
      placeSessions(lite);
      // S11: a drawer group with nothing to show is hidden, and so is the button when no group shows
      let groups = 0;
      document.querySelectorAll('[data-ops-group]').forEach(g => { g.hidden = !g.querySelector(':scope > section:not([hidden])'); if (!g.hidden) groups++; });
      document.querySelectorAll('header [data-cmd="toggleOps"]').forEach(b => { b.hidden = lite || !groups; });
      if (lite && state.tab !== 'all') applyTab('all');
      syncUi();
      // an untrusted folder: the host refuses these anyway; the buttons show it (the status line says why)
      const off = m.sections.untrusted === true;
      document.querySelectorAll('button[data-cmd]').forEach(b => { if (!b.closest('[aria-busy="true"]') && RUNS.test(b.getAttribute('data-cmd') || '')) b.disabled = off; });
      document.body.setAttribute('data-ready', '1');
    } else if (m.type === 'chatState') {
      activeChatSessionId = typeof m.activeSessionId === 'string' ? m.activeSessionId : null;
      if (rpConfirmGo && typeof m.confirmBeforeGo === 'boolean') rpConfirmGo.checked = m.confirmBeforeGo;
      if (rpSyncIde && typeof m.syncToIde === 'boolean') rpSyncIde.checked = m.syncToIde;
      if (rpAutoTake && typeof m.autoTakeTasks === 'boolean') rpAutoTake.checked = m.autoTakeTasks;
      if (typeof m.chatHtml === 'string') applyChatHtml(m.chatHtml);
    } else if (m.type === 'repromptResult') {
      if (rpOutput && typeof m.rewritten === 'string') {
        rpOutput.value = m.rewritten;
        state.rp.output = m.rewritten; save();
      }
      say(String(m.text || 'Prompt normalized.'), !!m.ok, 'reprompt');
    } else if (m.type === 'orchestrateResult') {
      if (orchOutput && typeof m.output === 'string') {
        orchOutput.textContent = m.output;
        orchOutput.hidden = !m.output;
      }
      say(String(m.text || ''), !!m.ok, 'orchestrator');
    } else if (m.type === 'rowNote' && typeof m.sessionId === 'string' && typeof m.text === 'string') {
      rowNotes[m.sessionId] = { text: m.text.slice(0, 300), where: m.where === 'composer' ? 'composer' : 'row' };
      applyRowNotes();
    } else if (m.type === 'switchTab' && typeof m.tab === 'string') {
      applyTab(m.tab, true);
    } else if (m.type === 'merging' && typeof m.id === 'string') {
      setMerging(m.id, !!m.on);
    } else if (m.type === 'result') {
      if (m.where === 'waiting') for (const id of Object.keys(merging)) setMerging(id, false);
      const where = m.where === 'gemini' ? diffWhere : (typeof m.where === 'string' ? m.where : '');
      if (typeof m.removal === 'string') {
        // P2-272: the answer to a worktree row shows directly under that row (no overlay)
        const p = document.querySelector('[data-removal-msg]' + attr('data-removal-msg', m.removal));
        if (p) { p.textContent = String(m.text || ''); p.classList.toggle('wait-msg-error', !m.ok); fade(p); }
        else say(String(m.text || ''), !!m.ok, where);
      } else say(String(m.text || ''), !!m.ok, where);
      if (m.ok && m.cleared) {
        if (!m.where) { note.value = ''; state.draft = ''; save(); showCount(); }
        else if (m.where === 'waiting' && typeof m.n === 'string') setAnswer(m.n, false);
        else if (m.where === 'jobs') {
          const id = typeof m.job === 'string' ? 'reply-' + m.job : 'job-prompt', f = document.getElementById(id);
          if (f) f.value = ''; delete state.fields[id]; save();
        }
        else if (m.where === 'task' && taskTitle) { taskTitle.value = ''; taskText.value = ''; taskKind.value = 'auto'; if (taskTest) taskTest.value = ''; state.task = {}; save(); }
      }
    }
  });

  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const cmd = b.getAttribute('data-cmd'), kind = b.getAttribute('data-send'), n = b.getAttribute('data-n'), id = b.getAttribute('data-id');
    if (kind) {
      const text = note.value.trim();
      if (!text) { say('Write something first.', false); note.focus(); return; }
      if (text.length > MAX) { say('That is over 4,000 characters. Please shorten it.', false); return; }
      vscode.postMessage({ cmd: 'send', kind, text });
    } else if (cmd === 'openAdvice') {
      vscode.postMessage({ cmd, id, which: b.getAttribute('data-which') });
    } else if (cmd === 'removal') {
      vscode.postMessage({ cmd, id, choice: b.getAttribute('data-choice') });
    } else if (cmd === 'refresh' || cmd === 'kill' || cmd === 'unkill' || cmd === 'installAsk' || cmd === 'copyAutomation') {
      vscode.postMessage({ cmd });
    } else if (cmd === 'more') {
      const on = b.getAttribute('aria-expanded') !== 'true';
      setMore(b, on); state.more[b.getAttribute('data-key')] = on; save();
    } else if (cmd === 'showAll') {
      const on = b.getAttribute('aria-expanded') !== 'true';
      setShowAll(b, on); state.showAll[b.getAttribute('data-list')] = on; save();
    } else if (cmd === 'okQuestion' || (cmd === 'decide' && b.getAttribute('data-choice') === 'ok')) {
      const key = cmd === 'okQuestion' ? 'q' + n : 's' + id;
      const confirmed = !!armed[key];
      if (b.hasAttribute('data-money') && !confirmed) { setArmed(key, true); return; }
      setArmed(key, false);
      if (cmd === 'okQuestion') vscode.postMessage({ cmd: 'answerQuestion', n, useRecommended: true, confirmed });
      else if (merging[id]) return;
      else vscode.postMessage({ cmd: 'decideSuggestion', id, choice: 'ok', confirmed });
    } else if (cmd === 'decide') {
      vscode.postMessage({ cmd: 'decideSuggestion', id, choice: b.getAttribute('data-choice') });
    } else if (cmd === 'openAnswer') {
      setAnswer(n, b.getAttribute('aria-expanded') !== 'true', true);
    } else if (cmd === 'cancelAnswer') {
      setAnswer(n, false);
      const open = q('[data-cmd="openAnswer"]' + attr('data-n', n)); if (open) open.focus();
    } else if (cmd === 'sendAnswer') {
      const ta = document.getElementById('ans-text-' + n), text = ta ? ta.value.trim() : '';
      if (!text) { say('Write an answer first.', false, 'waiting'); if (ta) ta.focus(); return; }
      if (text.length > MAX) { say('That is over 4,000 characters. Please shorten it.', false, 'waiting'); return; }
      vscode.postMessage({ cmd: 'answerQuestion', n, text });
    } else if (cmd === 'laterQuestion') {
      vscode.postMessage({ cmd, n });
    } else if (cmd === 'openTaskDiff') {
      diffWhere = b.closest('[data-slot="waiting"]') ? 'waiting' : 'gemini';
      vscode.postMessage({ cmd, id });
    } else if (cmd === 'jobStart') {
      const val = i => { const f = document.getElementById(i); return f ? f.value.trim() : ''; };
      const project = val('job-project'), prompt = val('job-prompt'), turns = val('job-turns');
      if (!project) { say('Choose a project first.', false, 'jobs'); return; }
      if (!prompt) { say('Write what the job should do first.', false, 'jobs'); const f = document.getElementById('job-prompt'); if (f) f.focus(); return; }
      if (prompt.length > MAX_PROMPT) { say('That is over 8,000 characters. Please shorten it.', false, 'jobs'); return; }
      if (turns && !/^\d{1,3}$/.test(turns)) { say('Turns must be a whole number from 1 to 400.', false, 'jobs'); return; }
      vscode.postMessage({ cmd, project, prompt, model: val('job-model') || 'sonnet', mode: val('job-mode') || 'auto', ...(turns ? { max_turns: Number(turns) } : {}) });
    } else if (cmd === 'jobReply') {
      const job = b.getAttribute('data-job'), ta = q('textarea' + attr('data-reply', job)), prompt = ta ? ta.value.trim() : '';
      if (!prompt) { say('Write a reply first.', false, 'jobs'); if (ta) ta.focus(); return; }
      if (prompt.length > MAX_PROMPT) { say('That is over 8,000 characters. Please shorten it.', false, 'jobs'); return; }
      vscode.postMessage({ cmd, job, prompt });
    } else if (cmd === 'jobStop') {
      vscode.postMessage({ cmd, job: b.getAttribute('data-job') });
    } else if (cmd === 'trustKey' || cmd === 'rejectKey') {
      vscode.postMessage({ cmd, id });
    } else if (cmd === 'remoteOn' || cmd === 'remoteOff') {
      vscode.postMessage({ cmd });
    } else if (cmd === 'addTask' && taskTitle) {
      const title = taskTitle.value.trim(), text = taskText.value.trim();
      if (!title) { say('Write a title first.', false, 'task'); taskTitle.focus(); return; }
      if (title.length > MAX_TITLE) { say('The title is over 200 characters. Please shorten it.', false, 'task'); return; }
      if (text.length > MAX) { say('The details are over 4,000 characters. Please shorten them.', false, 'task'); return; }
      const test = taskTest ? taskTest.value.trim() : '';
      if (test.length > 500) { say('The test command is over 500 characters. Please shorten it.', false, 'task'); return; }
      vscode.postMessage({ cmd, title, text, kind: taskKind.value, ...(test ? { test } : {}) });
    } else if (cmd === 'switchTab') {
      applyTab(b.getAttribute('data-tab'), true);
    } else if (cmd === 'toggleWaiting' || cmd === 'toggleOps' || cmd === 'toggleRail') {
      const k = cmd === 'toggleWaiting' ? 'waiting' : cmd === 'toggleOps' ? 'ops' : 'rail';
      const on = k === 'rail' ? state.ui.rail === false : state.ui[k] !== true;
      setUi(k, on);
    } else if (cmd === 'toggleRpMode') {
      if (rpAutoMode) { rpAutoMode.checked = !rpAutoMode.checked; rpAutoMode.dispatchEvent(new Event('change', { bubbles: true })); }
      syncModePill();
    } else if (cmd === 'rpChipRemove') {
      const tok = b.getAttribute('data-tok') || '';
      if (rpSkills) {
        rpSkills.value = rpSkills.value.split(/\s+/).filter(t => t && t !== tok).join(' ');
        rpSkills.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (cmd === 'watchdogScan' || cmd === 'watchdogRecover') {
      say(cmd === 'watchdogRecover' ? 'Recovering hanging Watchkeeper items…' : 'Running Watchdog scan…', true, 'jobs');
      vscode.postMessage({ cmd });
    } else if (cmd === 'graphRefresh') {
      const gb = document.getElementById('graph-badge');
      if (gb) gb.textContent = 'Graph: updating…';
      b.disabled = true;
      vscode.postMessage({ cmd });
    } else if (cmd === 'skillApprove' || cmd === 'skillReject') {
      say(cmd === 'skillApprove' ? 'Approving and indexing…' : 'Rejecting…', true, b.closest('#sec-review') ? 'review' : 'skills');
      vscode.postMessage({ cmd, slug: b.getAttribute('data-slug') || '' });
    } else if (cmd === 'openWorkspace' || cmd === 'toggleMaximize' || cmd === 'popOutWorkspace' || cmd === 'skillsSync') {
      if (cmd === 'skillsSync') say('Checking trending GitHub skill libraries…', true, 'skills');
      vscode.postMessage({ cmd });
    } else if (cmd === 'repromptStudio') {
      vscode.postMessage({ cmd, tab: 'reprompt' });
    } else if (cmd === 'repromptRewrite') {
      const draft = rpDraft ? rpDraft.value.trim() : '';
      if (!draft) { say('Write a rough prompt first.', false, 'reprompt'); if (rpDraft) rpDraft.focus(); return; }
      if (draft.length > MAX_PROMPT) { say('That is over 8,000 characters. Please shorten it.', false, 'reprompt'); return; }
      say('Rewriting prompt and selecting skills…', true, 'reprompt');
      vscode.postMessage({
        cmd,
        draft,
        target: rpTarget ? rpTarget.value : 'antigravity',
        mode: rpMode ? rpMode.value : 'balanced',
        skills: rpSkills ? rpSkills.value.trim() : '',
      });
    } else if (cmd === 'repromptSend' || cmd === 'repromptCopy') {
      const text = (rpOutput && rpOutput.value.trim()) || (rpDraft && rpDraft.value.trim()) || '';
      if (!text) { say('Write or rewrite a prompt first.', false, 'reprompt'); return; }
      if (cmd === 'repromptSend' && text.length > MAX_PROMPT) { say('That is over 8,000 characters. Please shorten it.', false, 'reprompt'); return; }
      if (cmd === 'repromptCopy') vscode.postMessage({ cmd, text });
      else vscode.postMessage({ cmd, text, target: b.getAttribute('data-target') || 'antigravity' });
    } else if (cmd === 'orchestrateRun') {
      const prompt = orchPrompt ? orchPrompt.value.trim() : '';
      if (!prompt) { say('Write a task first.', false, 'orchestrator'); if (orchPrompt) orchPrompt.focus(); return; }
      if (prompt.length > MAX_PROMPT) { say('That is over 8,000 characters. Please shorten it.', false, 'orchestrator'); return; }
      say('Running…', true, 'orchestrator');
      vscode.postMessage({ cmd, prompt, prefer: orchPrefer ? orchPrefer.value : 'auto' });
    } else if (cmd === 'chatDraft') {
      sendChatDraft();
    } else if (cmd === 'chatConfirm' || cmd === 'chatSendToIde') {
      const sid = b.getAttribute('data-session-id') || activeChatSessionId || '';
      const tid = b.getAttribute('data-turn-id') || '';
      const specEl = document.getElementById('confirm-spec-' + tid);
      const tEl = document.getElementById('confirm-target-' + tid);
      const mEl = document.getElementById('confirm-mode-' + tid);
      const rEl = document.getElementById('confirm-route-' + tid);
      const sEl = document.getElementById('confirm-skills-' + tid);
      delete confirmDrafts[tid];
      const skillTokens = sEl ? sEl.value.trim().split(/\s+/).filter(Boolean) : null;
      if (cmd === 'chatConfirm') say('Running Watchkeeper workflow (live model thinking enabled)…', true, 'reprompt');
      vscode.postMessage({
        cmd,
        sessionId: sid,
        turnId: tid,
        repromptedText: specEl ? specEl.value.trim() : '',
        target: tEl ? tEl.value : 'auto',
        mode: mEl ? mEl.value : 'auto',
        route: rEl ? rEl.value : 'auto',
        skills: skillTokens,
      });
    } else if (cmd === 'chatCancel') {
      const sid = b.getAttribute('data-session-id') || activeChatSessionId || '';
      const tid = b.getAttribute('data-turn-id') || '';
      delete confirmDrafts[tid];
      vscode.postMessage({ cmd: 'chatCancel', sessionId: sid, turnId: tid });
    } else if (cmd === 'dagRun' || cmd === 'dagNotNow' || cmd === 'dagStop' || cmd === 'dagMerge' || cmd === 'dagMergeNo' || cmd === 'dagCheck') {
      // P2-272 4B: the plan card's buttons; one click each, the button turns off until the stream redraws.
      const ftid = b.getAttribute('data-turn-id') || '';
      dagFocus = { ids: DAG_NEXT[cmd].map(n => `dag-${n}-${ftid}`), tries: 6 };
      b.disabled = true;
      vscode.postMessage({ cmd, sessionId: b.getAttribute('data-session-id') || activeChatSessionId || '', turnId: b.getAttribute('data-turn-id') || '' });
    } else if (cmd === 'chatDropSkill') {
      const tid = b.getAttribute('data-turn-id') || '';
      const dropName = (b.getAttribute('data-skill') || '').toLowerCase();
      const sEl = document.getElementById('confirm-skills-' + tid);
      if (sEl && dropName) {
        sEl.value = sEl.value.split(/\s+/).filter(tok => tok && tok.replace(/^[+-@]skill:/i, '').toLowerCase() !== dropName).join(' ');
      }
      if (tid && dropName) {
        const cur = confirmDrafts[tid] || { droppedSkills: [] };
        const dropped = Array.isArray(cur.droppedSkills) ? [...cur.droppedSkills] : [];
        if (!dropped.includes(dropName)) dropped.push(dropName);
        confirmDrafts[tid] = { ...cur, droppedSkills: dropped };
      }
      const chip = b.closest('.skill-chip');
      if (chip) chip.remove();
      captureConfirmDrafts(chatThread);
    } else if (cmd === 'chatTakeTask') {
      const tid = b.getAttribute('data-task-id') || '';
      applyTab('reprompt');
      say('Claiming Watchkeeper task into Antigravity simulated session…', true, 'reprompt');
      vscode.postMessage(tid ? { cmd: 'chatTakeTask', taskId: tid } : { cmd: 'chatTakeTask' });
    } else if (cmd === 'chatHandoffToClaude') {
      const sid = b.getAttribute('data-session-id') || activeChatSessionId || '';
      if (!sid) { say('Select a Watchkeeper session first.', false, 'reprompt'); return; }
      say('Publishing shared-workspace handoff for Claude Code…', true, 'reprompt');
      vscode.postMessage({ cmd: 'chatHandoffToClaude', sessionId: sid });
    } else if (cmd === 'openUsage') {
      const lim = document.getElementById('wk-limits');
      if (state.ui.rail === false) setUi('rail', true);
      if (lim) { lim.open = true; state.open['wk-limits'] = true; save(); fade(lim); if (lim.scrollIntoView) lim.scrollIntoView({ block: 'nearest', behavior: 'auto' }); const s = lim.querySelector('summary'); if (s) s.focus(); }
    } else if (cmd === 'chatPurgeAsk' || cmd === 'chatPurgeKeep') {
      const sid = b.getAttribute('data-session-id') || '', box = q('[data-purge-confirm]' + attr('data-purge-confirm', sid));
      const ask = q('[data-cmd="chatPurgeAsk"]' + attr('data-session-id', sid));
      if (!box) return;
      const on = cmd === 'chatPurgeAsk';
      box.hidden = !on;
      if (ask) ask.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) { fade(box); const d = box.querySelector('[data-cmd="chatPurge"]'); if (d) d.focus(); } else if (ask) ask.focus();
    } else if (cmd === 'chatPurge') {
      const sid = b.getAttribute('data-session-id') || '';
      if (!sid) return;
      clearRowNote(sid);
      vscode.postMessage({ cmd: 'chatPurge', sessionId: sid, confirmed: true });
    } else if (cmd === 'chatDone' || cmd === 'chatReopen') {
      const sid = b.getAttribute('data-session-id') || (cmd === 'chatDone' ? activeChatSessionId || '' : '');
      if (sid) clearRowNote(sid);
      if (cmd === 'chatReopen') { if (!sid) return; activeChatSessionId = sid; applyTab('reprompt'); }
      vscode.postMessage(sid ? { cmd, sessionId: sid } : { cmd });
    } else if (cmd === 'chatNew' || cmd === 'chatSelect' || cmd === 'chatDelete' || cmd === 'chatInspectClaude' || cmd === 'chatContinueFromClaude') {
      const sid = b.getAttribute('data-session-id') || '';
      if (cmd === 'chatNew') { activeChatSessionId = null; }
      else if (cmd === 'chatSelect') { activeChatSessionId = sid; }
      if (cmd !== 'chatDelete') applyTab('reprompt');
      vscode.postMessage(sid ? { cmd, sessionId: sid } : { cmd });
    } else if (cmd === 'chatCopyAnswer') {
      const ansEl = b.closest('.chat-assistant') && b.closest('.chat-assistant').querySelector('.chat-answer-body');
      const text = ansEl ? ansEl.textContent : '';
      if (text) vscode.postMessage({ cmd: 'repromptCopy', text });
    } else if (cmd === 'skillPin') {
      const sk = b.getAttribute('data-skill') || '';
      if (sk && rpSkills) {
        const tok = `+skill:${sk}`;
        const cur = rpSkills.value.trim();
        if (!cur.includes(tok)) rpSkills.value = cur ? `${cur} ${tok}` : tok;
        state.rp.skills = rpSkills.value; save();
        syncChips();
      }
      applyTab('reprompt');
      say(`Pinned +skill:${sk} into Watchkeeper Session.`, true, 'reprompt');
      if (rpDraft) rpDraft.focus();
    }
  });

  vscode.postMessage({ cmd: 'ready' });
})();
