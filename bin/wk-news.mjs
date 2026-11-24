#!/usr/bin/env node
// wk-news (P2-272): the developer's news drafts, before they are signed (node bin/wk-sign.mjs news).
//   wk-news add --kind news|update|tip --title "..." (--body "..." | --file <path>) [--link https://...] [--date YYYY-MM-DD]
//   wk-news list | show <id> | remove <id>
// A draft is a plain-text file in release/news-drafts/<YYYY-MM-DD>-<kind>-<slug>.txt: the title on the first line, then
// the body; an optional last line "Link: https://..." adds a link. Nothing here signs or sends anything.
// Users reach the developer at the address in release/contact.txt (private; it travels inside every signed news.json).
// Env (tests): WK_UPDATE_REPO (default: this folder).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS, CONTACT_IN_REPO, readContact, plainText } from './channel-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const repoDir = () => path.resolve(process.env.WK_UPDATE_REPO || path.join(HERE, '..'));
export const draftsDir = (repo = repoDir()) => path.join(repo, 'release', 'news-drafts');
const NAME = /^(\d{4}-\d{2}-\d{2})-(news|update|tip)-([a-z0-9][a-z0-9-]{0,60})\.txt$/;

export const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'item';

// One draft file as a news item; throws with the reason in words.
export function parseDraft(name, text) {
  const m = NAME.exec(name);
  if (!m) throw new Error(`${name}: the name is not <YYYY-MM-DD>-<news|update|tip>-<slug>.txt`);
  const lines = plainText(text).replace(/\s+$/, '').split('\n');
  const title = (lines.shift() || '').trim();
  let link;
  if (lines.length && /^Link:\s*/i.test(lines[lines.length - 1])) {
    link = lines.pop().replace(/^Link:\s*/i, '').trim();
    let u; try { u = new URL(link); } catch { u = null; }
    if (!u || u.protocol !== 'https:') throw new Error(`${name}: the link is not https`);
  }
  const body = lines.join('\n').trim();
  if (!title) throw new Error(`${name}: no title on the first line`);
  if (!body) throw new Error(`${name}: no body under the title`);
  const item = { id: `${m[1]}-${m[3]}`, date: m[1], kind: m[2], title, body };
  if (link) item.link = link;
  return item;
}

// Every draft, oldest first; a bad file is named in problems, never skipped silently.
export function readDrafts(dir = draftsDir()) {
  const items = [], problems = [];
  let names = []; try { names = fs.readdirSync(dir).filter(n => n.endsWith('.txt')).sort(); } catch { /* no drafts yet */ }
  for (const n of names) {
    try { items.push({ file: n, ...parseDraft(n, fs.readFileSync(path.join(dir, n), 'utf8')) }); } catch (e) { problems.push(e.message); }
  }
  const seen = new Set();
  for (const it of items) { if (seen.has(it.id)) problems.push(`two drafts have the id ${it.id}`); seen.add(it.id); }
  return { items, problems };
}

export function addDraft({ dir = draftsDir(), kind, title, body, link, date = new Date().toISOString().slice(0, 10) }) {
  if (!KINDS.includes(kind)) throw new Error(`--kind must be one of ${KINDS.join(', ')}`);
  title = plainText(title || '').replace(/\n/g, ' ').trim(); body = plainText(body || '').trim();
  if (!title) throw new Error('--title is empty');
  if (!body) throw new Error('the body is empty');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date must be YYYY-MM-DD');
  const name = `${date}-${kind}-${slug(title)}.txt`;
  const text = `${title}\n\n${body}\n${link ? `Link: ${link}\n` : ''}`;
  parseDraft(name, text);   // the same check the signer makes
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (fs.existsSync(file)) throw new Error(`${name} exists already; remove it first or change the title`);
  fs.writeFileSync(file, text);
  return name;
}

const USAGE = `usage: wk-news add --kind news|update|tip --title "..." (--body "..." | --file <path>) [--link https://...] [--date YYYY-MM-DD]
       wk-news list | show <id> | remove <id>
Drafts live in release/news-drafts/. Sign them with: node bin/wk-sign.mjs news (in your own terminal).
Users reach you at the address in ${CONTACT_IN_REPO} (now: ${readContact(repoDir()) || 'not set'}).`;

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const a = process.argv.slice(2);
  const opt = k => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const cmd = a[0];
  const find = id => readDrafts().items.find(it => it.id === id || it.file === id);
  try {
    if (!cmd || a.includes('--help') || a.includes('-h')) { console.log(USAGE); process.exit(cmd ? 0 : 2); }
    if (cmd === 'add') {
      const file = opt('--file');
      const name = addDraft({ kind: opt('--kind'), title: opt('--title'), body: file ? fs.readFileSync(file, 'utf8') : opt('--body'), link: opt('--link'), date: opt('--date') || undefined });
      console.log(`Draft saved: release/news-drafts/${name}. Sign the drafts with: node bin/wk-sign.mjs news`);
    } else if (cmd === 'list') {
      const { items, problems } = readDrafts();
      if (!items.length) console.log('No drafts.');
      for (const it of items) console.log(`${it.id}  [${it.kind}]  ${it.title}`);
      for (const p of problems) console.log(`problem: ${p}`);
      process.exit(problems.length ? 1 : 0);
    } else if (cmd === 'show') {
      const it = find(a[1]); if (!it) throw new Error(`no draft ${a[1]}`);
      console.log(`${it.title}\n[${it.kind}, ${it.date}]\n\n${it.body}${it.link ? `\n\nLink: ${it.link}` : ''}`);
    } else if (cmd === 'remove') {
      const it = find(a[1]); if (!it) throw new Error(`no draft ${a[1]}`);
      const dir = draftsDir(), bak = path.join(dir, '.removed');
      fs.mkdirSync(bak, { recursive: true });
      fs.renameSync(path.join(dir, it.file), path.join(bak, it.file));   // kept, not deleted
      console.log(`Removed ${it.id} (kept in release/news-drafts/.removed/).`);
    } else { console.error(USAGE); process.exit(2); }
  } catch (e) { console.error(`wk-news: ${e.message}`); process.exit(1); }
}
