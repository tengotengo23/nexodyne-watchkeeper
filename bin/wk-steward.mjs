#!/usr/bin/env node
// wk-steward: the steward's command line (P2-187). Library: steward-lib.mjs.
//   tick [--project id] [--lens key] [--dry-run] [--force] [--brief] [--json]   one visit (what the scheduler runs)
//   plan [--project id] [--lens key] [--brief]                                  what the next visit would do; makes no call
//   inbox [--project id] [--json]      ideas waiting for your yes or no        answer <id> yes|no|later [note]
//   status [--json]    report [--save] [--json]    retro [--json]    init    phase <shadow|half|full>
// Exit codes: 0 done · 1 wrong use or config · 2 safety refusal (policy, kill switch, privacy, billing mode) · 3 held (not now) · 4 the call failed
import fs from 'node:fs'; import path from 'node:path';
import * as S from './steward-lib.mjs';

const USAGE = 'usage: wk-steward tick|plan|inbox|answer|status|report|retro|init|phase  (see the top of bin/wk-steward.mjs)';
const BOOL = new Set(['dry-run', 'force', 'brief', 'json', 'save']), VAL = new Set(['project', 'lens']);
function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); if (BOOL.has(k)) o[k] = true; else if (VAL.has(k)) { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new S.StewardError(`--${k} needs a value`, 1); o[k] = argv[++i]; } else throw new S.StewardError(`unknown option ${a}`, 1); }
    else o._.push(a);
  }
  return o;
}
const pct = v => Number.isFinite(v) ? Math.round(v * 100) + '%' : '?';
const usd = v => Number.isFinite(v) ? 'US$' + v.toFixed(4) : '?';
const when = ms => new Date(ms).toISOString().replace('.000Z', 'Z');
const dropText = d => { const e = Object.entries(d || {}); return e.length ? ' (dropped: ' + e.map(([k, n]) => `${k} ${n}`).join(', ') + ')' : ''; };
function finish(text, code) { process.stdout.write(text.endsWith('\n') ? text : text + '\n', () => process.exit(code)); }

function tickText(r) {
  if (r.dryRun && r.wouldCall) return `would visit ${r.project} with lens ${r.lens}${r.wild ? ' (a wildcard visit)' : ''}; the brief is ${r.briefChars} characters (about ${r.briefTokens} tokens); the week is ${pct(r.pace.used)} used, the limit now is ${pct(r.pace.limit)}, headroom ${pct(r.pace.headroom)}; mode ${r.mode}; no call was made` + (r.brief ? '\n\n' + r.brief : '');
  if (r.held) return `held (${r.held}): ${r.detail}` + (r.dryRun ? ' [dry run]' : '');
  switch (r.outcome) {
    case 'ok': return `visited ${r.project} (lens ${r.lens}${r.wild ? ', wildcard' : ''}): ${r.kept} new idea${r.kept === 1 ? '' : 's'} of ${r.proposed} proposed${dropText(r.dropped)}${r.qa ? `, ${r.qa} assumption${r.qa === 1 ? '' : 's'} noted` : ''}; ${usd(r.cost_usd)}; the week is ${pct(r.meter?.used ?? r.pace?.used)} used`;
    case 'invalid': return `visited ${r.project}, but the answer had no usable ideas (${r.reason}); ${usd(r.cost_usd)}`;
    case 'limit': return `the account is at its usage limit; waiting until ${r.until}`;
    case 'refused': return `refused: ${r.detail}`;
    case 'killed': return 'stopped: the kill switch went on during the call';
    case 'timeout': return `the call for ${r.project} timed out and was stopped`;
    default: return `the call for ${r.project} failed (${r.reason || r.outcome}); ${usd(r.cost_usd)}`;
  }
}

function statusText(s) {
  const L = [], p = s.pace;
  L.push(`Mode ${s.mode}, phase ${s.phase}: at most ${s.cap} visits in 24 h (${s.visits24h} so far).`);
  L.push(`The week ends ${when(s.win.end)}. Used ${pct(s.used)} (${s.source === 'meter' ? `read from the meter ${Math.round(s.meterAgeMin)} min ago` : 'estimated from the spend ledger; the meter is unknown'}); the straight line is ${pct(s.win.elapsed)}; the limit now is ${pct(p.limit)}${p.lastStretch ? ' (last stretch: landing)' : ''}; headroom ${pct(p.headroom)}.`);
  L.push(`Pace: ${p.go ? 'go' : 'hold (' + p.reason + ')'}. Kill switch: ${s.killed === null ? 'unknown (policy error)' : s.killed ? 'ON' : 'off'}. Owner active: ${s.ownerActive.active ? 'yes' : 'no'}${s.ownerActive.ageMin !== null ? ` (last Claude activity ${Math.round(s.ownerActive.ageMin)} min ago)` : ''}. Lock: ${s.lock ? 'held by pid ' + s.lock.pid : 'free'}. Backoff: ${s.backoff ? 'until ' + when(s.backoff.until) + ' (' + s.backoff.reason + ')' : 'none'}.`);
  L.push(`Projects: ${s.projects.length ? s.projects.map(x => `${x.id} w${x.weight}${x.paused ? ' paused' : ''}`).join(', ') : 'none'}${s.skipped.length ? '. Skipped now: ' + s.skipped.map(x => `${x.id} (${x.why})`).join('; ') : ''}${s.problems.length ? '. Problems: ' + s.problems.join('; ') : ''}.`);
  L.push(`Ideas: ${s.ideas.open} open (${s.ideas.auto} auto, ${s.ideas.ask} ask, ${s.ideas.wait} wait); ${s.ideas.answered} answered${s.ideas.accept === null ? '' : ', ' + pct(s.ideas.accept) + ' accepted'}.`);
  const k = s.tuning.knobs; L.push(`Tuning: ideasPerCall ${k.ideasPerCall}, minImpact ${k.minImpact}, pastIdeasInBrief ${k.pastIdeasInBrief}, wildcardEvery ${k.wildcardEvery}${s.tuning.pending ? `; testing ${s.tuning.pending.rule}: ${s.tuning.pending.knob} ${s.tuning.pending.from} to ${s.tuning.pending.to}` : ''}.`);
  const l = s.last; L.push(l ? `Last visit: ${l.tick} ${l.project || '-'} ${l.outcome}${l.reason ? ' (' + l.reason + ')' : ''}${s.unfinished ? `; ${s.unfinished} unfinished (it is closed at the next visit)` : ''}.` : s.unfinished ? `No finished visit yet; ${s.unfinished} unfinished (it is closed at the next visit).` : 'No visit yet.');
  if (s.warnings?.length) L.push('Config notes: ' + s.warnings.join('; ') + '.');
  return L.join('\n');
}
function reportText(r) {
  const by = Object.entries(r.byProject).map(([k, n]) => `${k} ${n}`).join(', ') || 'none', held = Object.entries(r.held).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  return [`Week ending ${r.weekEnds}`, `Used ${pct(r.used)} of the week (${r.source}); the line is ${pct(r.elapsed)}. Mean gap between the two at the visits: ${r.paceError === null ? 'n/a' : pct(r.paceError)}.`,
    `Visits ${r.visits} (${by}). Held: ${held}.`, `Steward spend ${usd(r.spendUsd)}. Ideas added ${r.ideasAdded}: ${r.yes} yes, ${r.no} no, ${r.open} open${r.acceptShare === null ? '' : '; accepted ' + pct(r.acceptShare)}${r.costPerAccepted === null ? '' : '; cost per accepted idea ' + usd(r.costPerAccepted)}.`,
    r.pace ? S.paceLine(r.pace) : null,
    r.tokens?.calls ? `Tokens per visit (median of ${r.tokens.calls}): ${r.tokens.inPerCall} in, ${r.tokens.outPerCall} out; the brief about ${r.tokens.briefEst ?? '?'} (estimate).` : 'Tokens per visit: no call yet.',
    r.tuningChanges.length ? 'Tuning: ' + r.tuningChanges.map(e => `${e.kind} ${e.rule} ${e.knob}${e.from !== undefined ? ` ${e.from} to ${e.to}` : ''}`).join('; ') + '.' : 'Tuning: no change this week.'].filter(Boolean).join('\n');
}
function inboxText(list) {
  if (!list.length) return 'Nothing is waiting for you.';
  return list.map(i => `${i.id} · ${i.project} · impact ${i.impact}, effort ${i.effort} · ${i.kind} · ${i.gate}\n  ${i.title}\n  Why: ${i.why}${i.ask ? '\n  Ask: ' + i.ask : ''}`).join('\n\n') + '\n\nAnswer with: wk-steward answer <id> yes|no|later [note]';
}

async function main() {
  const o = parse(process.argv.slice(2)), cmd = o._[0], json = !!o.json;
  if (!cmd) throw new S.StewardError(USAGE, 1);
  const cfg = () => S.loadConfig();
  switch (cmd) {
    case 'tick': case 'plan': {
      const r = await S.tick({ dryRun: cmd === 'plan' || !!o['dry-run'], force: !!o.force, project: o.project, lens: o.lens, showBrief: !!o.brief });
      return finish(json ? JSON.stringify(r) : tickText(r), r.code ?? 0);
    }
    case 'inbox': { const c = cfg(), list = S.inbox(S.derive(S.readEvents()), c, o.project); return finish(json ? JSON.stringify(list) : inboxText(list), 0); }
    case 'answer': {
      const [, id, ans, ...note] = o._; if (!id || !ans) throw new S.StewardError('usage: wk-steward answer <id> yes|no|later [note]', 1);
      const i = S.answerIdea(id, ans, note.join(' ')); return finish(json ? JSON.stringify({ id, answer: ans }) : `${id} marked ${ans}: ${i.title}`, 0);
    }
    case 'status': { const s = S.snapshot(cfg(), S.nowMs()); return finish(json ? JSON.stringify(s) : statusText(s), 0); }
    case 'report': {
      const r = S.report(cfg(), S.nowMs());
      if (o.save) { const f = path.join(S.stewardDir(), 'reports', r.weekEnds.slice(0, 10) + '.json'); S.writeAtomic(f, JSON.stringify(r, null, 2) + '\n'); }
      return finish(json ? JSON.stringify(r) : reportText(r) + (o.save ? '\n(saved)' : ''), 0);
    }
    case 'retro': {
      const c = cfg(), st = S.derive(S.readEvents()), tm = S.tickMetrics(st.counted.slice(-c.tuning.window)), am = S.answerMetrics([...st.ideas.values()]), log = S.tuningLog(20), t = S.loadTuning(c);
      const data = { knobs: t.knobs, pending: t.pending, blocks: t.blocks, ticks: tm, answers: am, log };
      const txt = [`Last ${tm.ticks} visits: ${tm.proposed} ideas proposed; repeats ${pct(tm.dupeRate)}, too weak ${pct(tm.lowRate)}, kept ${pct(tm.yieldRate)}.`, `Answers: ${am.n}${am.accept === null ? '' : ', accepted ' + pct(am.accept)}.`,
        log.length ? 'Recent tuning:\n' + log.map(e => `  ${e.kind} ${e.rule} ${e.knob} ${e.from !== undefined ? e.from + ' to ' + e.to : '= ' + e.value}${e.gain !== undefined ? ', gain ' + e.gain : ''}${e.why ? ' (' + e.why + ')' : ''}`).join('\n') : 'No tuning change yet.'].join('\n');
      return finish(json ? JSON.stringify(data) : txt, 0);
    }
    case 'init': { const r = S.initFiles(); return finish(json ? JSON.stringify(r) : `${r.created ? 'Created' : 'Found'} ${r.projects}. Edit it: your project folders, a weight (1-10) and your own words for goal, audience and number. State folder: ${r.dir}. Then: wk-steward plan`, 0); }
    case 'phase': {
      const name = o._[1]; if (!name) throw new S.StewardError('usage: wk-steward phase shadow|half|full', 1);
      const f = S.setPhase(name), c = cfg(); return finish(`phase ${name}: at most ${Math.max(1, Math.ceil(c.call.maxPerDay * c.pace.ramp[name]))} visits in 24 h (written to ${f})`, 0);
    }
    default: throw new S.StewardError(`unknown command "${cmd}". ${USAGE}`, 1);
  }
}
main().catch(e => { const code = e instanceof S.StewardError ? e.code : 1; process.stderr.write((e instanceof S.StewardError ? e.message : 'unexpected error: ' + (e?.stack || e)) + '\n', () => process.exit(code)); });
