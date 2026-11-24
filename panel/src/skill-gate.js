'use strict';
// P2-272 (B): the one rule for which skill sources count. JS twin of
// reprompt/scripts/skill_vault.py is_approved(); shared vectors in
// test/fixtures/skill-gate-vectors.json keep the two the same.
// Only a source whose `approved` is exactly true may be indexed, loaded, exposed or suggested.
// Presence on disk never counts. Index entries with slug "local-installed" are the owner's own skills.

const LOCAL_SLUG = 'local-installed';

// The reserved slug, compared without case or outer spaces, the same as skill_vault.py.
function isReserved(entry) {
  return !!entry && typeof entry === 'object' && String(entry.slug || '').trim().toLowerCase() === LOCAL_SLUG;
}

function isApproved(entry) {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry) && entry.approved === true && !isReserved(entry);
}

function approvedSources(sourcesDoc) {
  const repos = sourcesDoc && Array.isArray(sourcesDoc.repos) ? sourcesDoc.repos : [];
  return repos.filter(isApproved);
}

function pendingSources(sourcesDoc) {
  const repos = sourcesDoc && Array.isArray(sourcesDoc.repos) ? sourcesDoc.repos : [];
  return repos.filter(r => r && typeof r === 'object' && !Array.isArray(r) && !isReserved(r) && !isApproved(r) && (r.status || 'staged') === 'staged');
}

// An index entry is allowed when it is the owner's own (local-installed) or its source is approved.
// Matched by slug only, the same as skill_vault.py load_index(): a repo name never stands in for a slug.
function skillAllowed(skill, sourcesDoc) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return false;
  if (skill.slug === LOCAL_SLUG) return true;
  if (typeof skill.slug !== 'string' || !skill.slug) return false;
  const ok = new Set();
  for (const r of approvedSources(sourcesDoc)) { if (typeof r.slug === 'string' && r.slug) ok.add(r.slug); }
  return ok.has(skill.slug);
}

function allowedSkills(indexDoc, sourcesDoc) {
  const skills = indexDoc && Array.isArray(indexDoc.skills) ? indexDoc.skills : [];
  return skills.filter(s => skillAllowed(s, sourcesDoc));
}

// P2-273 (owner, 24 Nov: "<= 20 approved high-signal skills"): at most MAX_SKILLS skills reach the IDEs (bin/skill-expose.mjs)
// and the router (reprompt/scripts/skill_vault.py cap_skills, the Python twin; shared cap_cases in the vectors file).
// Rank: the owner's own skills (0), skills from approved sources (1), skills synced from the owner's Claude account (2,
// Claude Code loads those natively); index order within a rank.
const MAX_SKILLS = 20;
const SYNCED_PATH_RE = /[\\/]\.claude[\\/]skills[\\/]synced[\\/]/;

function isSyncedSkill(skill) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return false;
  return skill.synced === true || SYNCED_PATH_RE.test(String(skill.path || skill.dir || ''));
}

function skillRank(skill) {
  if (isSyncedSkill(skill)) return 2;
  return skill && skill.slug === LOCAL_SLUG ? 0 : 1;
}

function capSkills(skills, max = MAX_SKILLS) {
  const items = (Array.isArray(skills) ? skills : []).filter(x => x && typeof x === 'object' && !Array.isArray(x));
  const ranked = items.map((skill, i) => ({ skill, i, r: skillRank(skill) })).sort((a, b) => a.r - b.r || a.i - b.i);
  return { kept: ranked.slice(0, max).map(x => x.skill), over: ranked.slice(max).map(x => x.skill) };
}

module.exports = { LOCAL_SLUG, MAX_SKILLS, isReserved, isApproved, approvedSources, pendingSources, skillAllowed, allowedSkills, isSyncedSkill, skillRank, capSkills };
