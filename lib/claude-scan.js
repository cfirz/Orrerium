// Cross-repo Claude asset scanner: .claude/{skills,agents,commands} across
// configured roots plus the global ~/.claude, so the whole machine's agent
// setup lands on the graph, not just the vault's own routines.
// Same contract as vault.js: fs reads only - no http, no fs.watch, no timers.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './vault.js';

// ids must pass the server's SLUG_RE; repo dir names may carry spaces ("Kids Sim")
const sanitize = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '-');

const KIND_TYPE = { skill: 'routine', agent: 'agent', command: 'command' };

export function scanClaudeAssets({ roots = [], globalDir = null, settingsPath = null, skipDirs = [] } = {}) {
  const items = [];
  const warnings = [];
  const skip = new Set(skipDirs.map(normDir));
  const overrides = readOverrides(settingsPath, warnings);

  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (err) {
      warnings.push(`claude-scan: cannot read root ${root}: ${err.message}`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const repoDir = path.join(root, entry.name);
      if (skip.has(normDir(repoDir))) continue; // the vault scans its own skills
      collect(path.join(repoDir, '.claude'), {
        prefix: sanitize(entry.name), repo: entry.name, repoDir, scope: 'repo',
      }, items, warnings);
    }
  }
  if (globalDir) {
    collect(globalDir, { prefix: 'global', repo: null, repoDir: null, scope: 'global' }, items, warnings);
  }

  // skillOverrides keys are skill directory names, which can differ from the
  // frontmatter name (agent-advisor/ carries name: advisor) - match both
  for (const item of items) {
    if (item.kind === 'skill' && (overrides[item.stem] === 'off' || overrides[item.label] === 'off')) {
      item.disabled = true;
    }
  }
  return { items, warnings };
}

function collect(claudeDir, ctx, items, warnings) {
  // skills are one-per-directory manifests; agents and commands are flat .md files
  for (const dir of listDirs(claudeDir, 'skills')) {
    addItem(path.join(claudeDir, 'skills', dir, 'SKILL.md'), dir, 'skill', ctx, items, warnings);
  }
  for (const kind of ['agent', 'command']) {
    const sub = `${kind}s`;
    for (const file of listFiles(claudeDir, sub)) {
      if (!file.toLowerCase().endsWith('.md')) continue;
      addItem(path.join(claudeDir, sub, file), path.basename(file, '.md'), kind, ctx, items, warnings);
    }
  }
}

function addItem(filePath, stem, kind, ctx, items, warnings) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    warnings.push(`claude-scan: failed to read ${filePath}: ${err.message}`);
    return;
  }
  const { fields } = parseFrontmatter(text);
  const label = sanitize(typeof fields.name === 'string' && fields.name !== '' ? fields.name : stem);
  items.push({
    id: `${ctx.prefix}.${label}`,
    label,
    stem, // file/dir name, distinct from the frontmatter name (skillOverrides key on it)
    kind,
    type: KIND_TYPE[kind],
    scope: ctx.scope,
    repo: ctx.repo,
    repoDir: ctx.repoDir ? ctx.repoDir.replaceAll('\\', '/') : null,
    path: filePath.replaceAll('\\', '/'),
    description: typeof fields.description === 'string' && fields.description !== '' ? fields.description : null,
    disabled: false,
  });
}

// Append scanned items to a built graph: nodes, one anchor edge per repo item,
// degree upkeep. Mutates the graph buildGraph() returned - call it right after.
export function mergeClaudeAssets(graph, items) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const idByDir = new Map();
  for (const n of graph.nodes) {
    if (n.dir) idByDir.set(normDir(n.dir), n.id);
  }

  // anchor per repo: the vault project node whose `dir` frontmatter points at the
  // repo, else a synthetic repo node so the items still hang together
  const anchors = new Map();
  const anchorFor = (item) => {
    if (item.scope !== 'repo') return null;
    if (anchors.has(item.repo)) return anchors.get(item.repo);
    let anchor = idByDir.get(normDir(item.repoDir)) ?? null;
    if (!anchor) {
      anchor = byId.has(item.repo) ? `repo-${sanitize(item.repo)}` : sanitize(item.repo);
      const node = {
        id: anchor, label: item.repo, type: 'repo', folder: null,
        description: `repo at ${item.repoDir}`, tags: [], updated: null,
        status: null, dir: item.repoDir, degree: 0, scope: 'repo', disabled: false,
      };
      graph.nodes.push(node);
      byId.set(anchor, node);
    }
    anchors.set(item.repo, anchor);
    return anchor;
  };

  for (const item of items) {
    if (byId.has(item.id)) {
      graph.warnings.push(`claude-scan: duplicate id "${item.id}" (${item.path}) - skipped`);
      continue;
    }
    const node = {
      id: item.id, label: item.label, type: item.type, folder: null,
      description: item.description, tags: [], updated: null, status: null,
      dir: item.repoDir, degree: 0, scope: item.scope, disabled: item.disabled,
    };
    graph.nodes.push(node);
    byId.set(item.id, node);
    const anchor = anchorFor(item);
    if (anchor) {
      graph.edges.push({ source: anchor, target: item.id, kind: 'scan', count: 1 });
      node.degree += 1;
      byId.get(anchor).degree += 1;
    }
  }
  return graph;
}

// --- helpers -------------------------------------------------------------

function readOverrides(settingsPath, warnings) {
  if (!settingsPath) return {};
  let text;
  try {
    text = readFileSync(settingsPath, 'utf8');
  } catch {
    return {}; // no settings file - nothing disabled
  }
  try {
    const parsed = JSON.parse(text);
    return parsed?.skillOverrides && typeof parsed.skillOverrides === 'object' ? parsed.skillOverrides : {};
  } catch (err) {
    warnings.push(`claude-scan: settings.json unreadable: ${err.message}`);
    return {};
  }
}

function listDirs(base, sub = '') {
  try {
    return readdirSync(path.join(base, sub), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listFiles(base, sub) {
  try {
    return readdirSync(path.join(base, sub), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function normDir(p) {
  return path.resolve(p).replaceAll('\\', '/').toLowerCase();
}
