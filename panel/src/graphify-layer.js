'use strict';
// Default Graphify 2-hop structural & token-saving layer for Watchkeeper panel & orchestrator.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CODE_EXTS = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.wk', '.watchkeeper', 'dist', '__pycache__', 'graphify-out']);
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'when', 'what', 'make', 'add', 'fix',
  'update', 'create', 'build', 'check', 'test', 'tests', 'using', 'across', 'file', 'files', 'code', 'please',
  'want', 'need', 'should', 'all', 'new', 'only', 'also', 'then', 'than', 'more', 'some', 'how', 'why',
]);

function isBootstrappableWorkspace(wsDir) {
  if (!wsDir || typeof wsDir !== 'string') return false;
  try {
    const resolved = path.resolve(wsDir);
    const root = path.parse(resolved).root;
    if (resolved === root || resolved === path.resolve(os.homedir())) return false;
    if (!fs.statSync(resolved).isDirectory()) return false;
    return true;
  } catch {
    return false;
  }
}

function collectCodeFiles(wsDir, maxFiles = 200) {
  const files = [];
  const queue = [{ dir: wsDir, depth: 0 }];
  while (queue.length && files.length < maxFiles) {
    const { dir, depth } = queue.shift();
    if (depth > 5) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (files.length >= maxFiles) break;
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) queue.push({ dir: full, depth: depth + 1 });
      else if (ent.isFile() && CODE_EXTS.has(path.extname(ent.name).toLowerCase())) files.push(full);
    }
  }
  return files;
}

function estimateWorkspaceTokens(wsDir, files = null) {
  const list = Array.isArray(files) ? files : collectCodeFiles(wsDir, 200);
  let totalBytes = 0;
  for (const fp of list) {
    try { totalBytes += Math.min(256000, fs.statSync(fp).size); } catch { /* skip */ }
  }
  return Math.max(0, Math.round(totalBytes / 3.2));
}

function buildLightweightAstGraph(wsDir, maxFiles = 200) {
  const files = collectCodeFiles(wsDir, maxFiles);
  if (!files.length) return { graph: null, files: [] };

  const nodes = [];
  const links = [];
  const nodeIds = new Set();
  const byStem = new Map();
  const addNode = (id, label, type, file) => {
    if (nodeIds.has(id)) return;
    nodeIds.add(id);
    nodes.push({ id, label, type, file });
  };

  for (const fp of files) {
    const rel = path.relative(wsDir, fp).split(path.sep).join('/');
    const nid = `file:${rel}`;
    const base = path.basename(fp);
    const stem = path.basename(fp, path.extname(fp)).toLowerCase();
    addNode(nid, base, 'module', rel);
    if (!byStem.has(stem)) byStem.set(stem, nid);
  }

  for (const fp of files) {
    const rel = path.relative(wsDir, fp).split(path.sep).join('/');
    const srcId = `file:${rel}`;
    let text = '';
    try { text = fs.readFileSync(fp, 'utf8').slice(0, 64000); } catch { continue; }

    for (const m of text.matchAll(/(?:import\s+[^'"]*from\s+|from\s+([\w.]+)\s+import|require\()\s*['"]?([^'"\s)]+)/g)) {
      const targetRef = m[1] || m[2] || '';
      const clean = targetRef.split('.').pop();
      const stem = path.basename(clean || targetRef, path.extname(clean || targetRef)).toLowerCase();
      const tgtId = byStem.get(stem);
      if (tgtId && tgtId !== srcId) links.push({ source: srcId, target: tgtId, type: 'imports' });
    }
    for (const m of text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
      const symId = `sym:${rel}#${m[1]}`;
      addNode(symId, m[1], 'symbol', rel);
      links.push({ source: srcId, target: symId, type: 'defines' });
    }
  }

  return {
    files,
    graph: {
      schema_version: 1,
      graphify_version: 'watchkeeper-ast-2.0',
      generated_at: new Date().toISOString(),
      file_count: files.length,
      nodes,
      links,
    },
  };
}

function loadGraphJson(graphFile) {
  try {
    if (!fs.statSync(graphFile).isFile()) return null;
    const data = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    return data && typeof data === 'object' && Array.isArray(data.nodes) ? data : null;
  } catch {
    return null;
  }
}

function extractTokens(prompt) {
  const out = [];
  const seen = new Set();
  for (const raw of String(prompt || '').match(/[A-Za-z0-9_./-]{2,}/g) || []) {
    const low = raw.toLowerCase().replace(/^[./-]+|[./-]+$/g, '');
    if (low.length < 2 || STOPWORDS.has(low) || seen.has(low)) continue;
    seen.add(low);
    out.push(low);
    for (const part of low.split(/[/._-]+/)) {
      if (part.length >= 3 && !STOPWORDS.has(part) && !seen.has(part)) {
        seen.add(part);
        out.push(part);
      }
    }
  }
  return out;
}

function writeAtomicJson(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
}

// P2-272: real graph state from graphify-out/wk-coverage.json (+ the hook's changed-files list); plain data, no wording.
function readGraphStatus(workspaceDir, now = Date.now()) {
  const none = { known: false, indexed: 0, total: 0, truncated: false, ageMs: null, changed: 0 };
  if (!isBootstrappableWorkspace(workspaceDir)) return none;
  let cov;
  try { cov = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'graphify-out', 'wk-coverage.json'), 'utf8')); } catch { return none; }
  if (!cov || typeof cov !== 'object') return none;
  const built = Date.parse(cov.built_at);
  let changed = Number(cov.dirty_count) || 0;
  try {
    const crypto = require('crypto');
    const home = process.env.WK_HOME || path.join(os.homedir(), '.wk');
    const h = crypto.createHash('sha1').update((() => { try { return fs.realpathSync(workspaceDir); } catch { return path.resolve(workspaceDir); } })()).digest('hex').slice(0, 12);
    const c = JSON.parse(fs.readFileSync(path.join(home, 'graph-hook', h, 'changed.json'), 'utf8'));
    if (c && Array.isArray(c.files)) changed = c.files.length;
  } catch { /* no hook state yet */ }
  return {
    known: true, indexed: Number(cov.files_indexed) || 0, total: Number(cov.files_total) || 0, truncated: cov.truncated === true,
    ageMs: Number.isFinite(built) ? Math.max(0, now - built) : null, changed,
  };
}

function readGraphifyStats(workspaceDir) {
  if (!isBootstrappableWorkspace(workspaceDir)) {
    return { available: false, totalNodes: 0, totalEdges: 0, mode: 'none' };
  }
  const graphFile = path.join(workspaceDir, 'graphify-out', 'graph.json');
  const g = loadGraphJson(graphFile);
  if (!g) return { available: false, totalNodes: 0, totalEdges: 0, mode: 'standby' };
  const edges = g.links || g.edges || [];
  return {
    available: true,
    totalNodes: g.nodes.length,
    totalEdges: edges.length,
    mode: String(g.graphify_version || '').startsWith('watchkeeper-ast') ? 'ast' : 'graphify',
    status: readGraphStatus(workspaceDir),
  };
}

function getGraphifyContext(workspaceDir, prompt = '', { autoBootstrap = true, allowWrite = false, maxNodes = 20 } = {}) {
  const t0 = Date.now();
  if (process.env.WK_GRAPHIFY_DEFAULT === '0' || !isBootstrappableWorkspace(workspaceDir)) {
    return {
      available: false,
      mode: process.env.WK_GRAPHIFY_DEFAULT === '0' ? 'disabled' : 'absent',
      totalNodes: 0,
      totalEdges: 0,
      matchedNodes: 0,
      matchedEdges: 0,
      topFiles: [],
      edges: [],
      fullRepoEstTokens: 0,
      subgraphEstTokens: 0,
      savedTokens: 0,
      savedPct: 0,
      queryMs: Date.now() - t0,
      contextBlock: '',
    };
  }

  const wsDir = path.resolve(workspaceDir);
  const graphFile = path.join(wsDir, 'graphify-out', 'graph.json');
  let graphData = loadGraphJson(graphFile);
  let mode = graphData ? (String(graphData.graphify_version || '').startsWith('watchkeeper-ast') ? 'ast-cached' : 'graphify-cli') : 'absent';
  let scannedFiles = null;

  if (!graphData && autoBootstrap) {
    const built = buildLightweightAstGraph(wsDir, 200);
    graphData = built.graph;
    scannedFiles = built.files;
    if (graphData) {
      mode = 'ast-bootstrap';
      if (allowWrite) {
        try { writeAtomicJson(graphFile, graphData); } catch { /* non-fatal */ }
      }
    }
  }

  if (!graphData || !graphData.nodes.length) {
    return {
      available: false,
      mode,
      totalNodes: 0,
      totalEdges: 0,
      matchedNodes: 0,
      matchedEdges: 0,
      topFiles: [],
      edges: [],
      fullRepoEstTokens: 0,
      subgraphEstTokens: 0,
      savedTokens: 0,
      savedPct: 0,
      queryMs: Date.now() - t0,
      contextBlock: '',
    };
  }

  const byId = new Map();
  const inbound = new Map();
  const outbound = new Map();
  for (const n of graphData.nodes) {
    if (!n || !n.id) continue;
    const nid = String(n.id);
    byId.set(nid, n);
    inbound.set(nid, new Set());
    outbound.set(nid, new Set());
  }
  const rawEdges = graphData.links || graphData.edges || [];
  for (const e of rawEdges) {
    if (!e || typeof e !== 'object') continue;
    const src = String(e.source || e.src || '');
    const tgt = String(e.target || e.dst || '');
    if (byId.has(src) && byId.has(tgt)) {
      outbound.get(src).add(tgt);
      inbound.get(tgt).add(src);
    }
  }

  const tokens = extractTokens(prompt);
  const scored = [];
  for (const [nid, node] of byId.entries()) {
    const nfile = String(node.source_file || node.file || '');
    const lbl = String(node.label || nid);
    const hay = `${nid} ${lbl} ${nfile}`.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (tok === lbl.toLowerCase()) score += 6;
      else if (hay.includes(tok)) score += 2.5;
    }
    const centrality = inbound.get(nid).size + 0.5 * outbound.get(nid).size;
    if (score > 0 || tokens.length === 0) {
      scored.push([score + Math.min(3, centrality * 0.25), nid]);
    }
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  const seeds = (scored.length ? scored : [...byId.keys()].slice(0, 6).map(id => [0, id])).slice(0, 6).map(x => x[1]);

  const kept = [];
  const seen = new Set();
  let frontier = [...seeds];
  for (let hop = 0; hop < 2 && kept.length < maxNodes; hop += 1) {
    const next = [];
    for (const cur of frontier) {
      if (!seen.has(cur)) {
        seen.add(cur);
        kept.push(cur);
        if (kept.length >= maxNodes) break;
      }
      const neighbors = [...new Set([...inbound.get(cur), ...outbound.get(cur)])]
        .sort((a, b) => (inbound.get(b).size + outbound.get(b).size) - (inbound.get(a).size + outbound.get(a).size));
      for (const nb of neighbors.slice(0, 8)) {
        if (!seen.has(nb)) next.push(nb);
      }
    }
    frontier = next;
  }

  const keptSet = new Set(kept);
  const subNodes = kept.map(nid => {
    const n = byId.get(nid);
    return {
      id: nid,
      label: String(n.label || nid),
      file: String(n.source_file || n.file || ''),
      inDegree: inbound.get(nid).size,
      outDegree: outbound.get(nid).size,
    };
  });
  const subEdges = [];
  for (const e of rawEdges) {
    if (!e || typeof e !== 'object') continue;
    const s = String(e.source || e.src || '');
    const t = String(e.target || e.dst || '');
    if (keptSet.has(s) && keptSet.has(t)) subEdges.push({ source: s, target: t, type: e.type || 'edge' });
  }

  const topFiles = [];
  for (const sn of subNodes) {
    if (sn.file && !topFiles.includes(sn.file)) topFiles.push(sn.file);
    if (topFiles.length >= 8) break;
  }

  let fullRepoEstTokens = estimateWorkspaceTokens(wsDir, scannedFiles);
  if (fullRepoEstTokens <= 0) fullRepoEstTokens = Math.max(byId.size * 180, subNodes.length * 45);
  const compactSub = JSON.stringify({ nodes: subNodes, edges: subEdges.slice(0, 40) });
  const subgraphEstTokens = Math.max(1, Math.round(Buffer.byteLength(compactSub, 'utf8') / 3.2));
  const savedTokens = Math.max(0, fullRepoEstTokens - subgraphEstTokens);
  const savedPct = fullRepoEstTokens > 0 ? Math.round((savedTokens / fullRepoEstTokens) * 1000) / 10 : 0;

  const lines = [
    '## Graphify 2-Hop Context (Token-Saving Layer)',
    `- Graph coverage: ${byId.size} nodes, ${rawEdges.length} edges (${mode}).`,
    `- Estimated token savings: ~${savedTokens.toLocaleString('en-US')} tokens (${savedPct}% smaller than raw scan).`,
  ];
  if (topFiles.length) lines.push(`- Focus files: ${topFiles.map(f => `\`${f}\``).join(', ')}`);
  if (subEdges.length) lines.push(`- Key 2-hop edges: ${subEdges.slice(0, 6).map(e => `${e.source}->${e.target}`).join(', ')}`);
  lines.push('- Token-Saving Rule: Read only the focused graph files/callers above first before any broad search.');

  return {
    available: true,
    mode,
    totalNodes: byId.size,
    totalEdges: rawEdges.length,
    matchedNodes: subNodes.length,
    matchedEdges: Math.min(subEdges.length, 40),
    topFiles,
    edges: subEdges.slice(0, 20),
    fullRepoEstTokens,
    subgraphEstTokens,
    savedTokens,
    savedPct,
    queryMs: Date.now() - t0,
    contextBlock: lines.join('\n'),
  };
}

module.exports = {
  isBootstrappableWorkspace,
  estimateWorkspaceTokens,
  buildLightweightAstGraph,
  getGraphifyContext,
  readGraphifyStats,
  readGraphStatus,
};
