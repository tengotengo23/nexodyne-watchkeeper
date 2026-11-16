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
  state.open = obj(state.open);
  state.draft = typeof state.draft === 'string' ? state.draft : '';
  state.answers = obj(state.answers);     // question number -> draft text, while its answer box is open
  state.more = obj(state.more);           // expanded "More" texts
  state.showAll = obj(state.showAll);     // "Show all N" per list
  state.task = obj(state.task);           // the task form's draft
  state.fields = obj(state.fields);       // P2-227: drafts of the job form and the reply boxes, by element id
  const MAX_PROMPT = 8000;
  const KEEP = /^(job-(project|prompt|model|mode|turns)|reply-J-\d{8}-\d{4}-[0-9a-f]{4})$/;
  const save = () => vscode.setState(state);

  const note = document.getElementById('note');
  const count = document.getElementById('note-count');
  const feedback = document.getElementById('feedback');
  const taskTitle = document.getElementById('task-title'), taskText = document.getElementById('task-text'), taskKind = document.getElementById('task-kind'), taskTest = document.getElementById('task-test');
  const last = {};
  const merging = {};                     // suggestion id -> true while its merge runs
  const armed = {};                       // money confirm: key -> timer
  let diffWhere = 'gemini';

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

  const RUNS = /^(okQuestion|sendAnswer|decide|installAsk|jobStart|jobReply|jobStop|trustKey|rejectKey|remoteOn|remoteOff|addTask)$/;
  window.addEventListener('message', e => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'data' && m.sections && typeof m.sections === 'object') {
      document.querySelectorAll('[data-slot]').forEach(el => {
        const k = el.getAttribute('data-slot'), html = m.sections[k];
        if (typeof html !== 'string' || last[k] === html) return;
        // an answer being typed is never thrown away by a refresh: its box is rebuilt with the draft
        const typing = k === 'waiting' && el.contains(document.activeElement) && document.activeElement.hasAttribute('data-answer') ? document.activeElement.getAttribute('data-answer') : null;
        const focused = el.contains(document.activeElement) && document.activeElement.id && KEEP.test(document.activeElement.id) ? document.activeElement.id : null;
        last[k] = html;
        el.innerHTML = html;
        applyOpen(el);
        restoreFields(el);
        if (focused) { const f = document.getElementById(focused); if (f) f.focus(); }
        if (k === 'waiting') { restoreWaiting(el); if (typing) { const ta = document.getElementById('ans-text-' + typing); if (ta) ta.focus(); } }
        if (k !== 'updated') fade(el);
      });
      // without the Watchkeeper plugin only the sessions and the about note show; the new sections follow `show`
      const lite = m.sections.mode === 'sessions', show = obj(m.sections.show);
      document.querySelectorAll('[data-needs]').forEach(s => {
        const need = s.getAttribute('data-needs');
        s.hidden = need === 'no-plugin' ? !lite : need === 'plugin' ? lite : (lite || !show[need]);
      });
      // an untrusted folder: the host refuses these anyway; the buttons show it (the status line says why)
      const off = m.sections.untrusted === true;
      document.querySelectorAll('button[data-cmd]').forEach(b => { if (RUNS.test(b.getAttribute('data-cmd') || '')) b.disabled = off; });
      document.body.setAttribute('data-ready', '1');
    } else if (m.type === 'merging' && typeof m.id === 'string') {
      setMerging(m.id, !!m.on);
    } else if (m.type === 'result') {
      if (m.where === 'waiting') for (const id of Object.keys(merging)) setMerging(id, false);
      const where = m.where === 'gemini' ? diffWhere : (typeof m.where === 'string' ? m.where : '');
      say(String(m.text || ''), !!m.ok, where);
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
    }
  });

  vscode.postMessage({ cmd: 'ready' });
})();
