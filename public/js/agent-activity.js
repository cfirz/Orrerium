// Live agent activity on the graph: which nodes are running right now, and which
// edges are carrying work. Pure derivation (normDir..deriveActivity/diffPulses)
// wrapped by a controller that debounces the SSE firehose and decays on a timer.
// No DOM, no d3 in the pure half - node --test imports it directly.
//
// Motion is CSS-only (see style.css "live agent activity"); this module never
// animates anything, it only decides what is live and hands the view two maps.

// hot/warm thresholds. WARM_MS deliberately equals DEFAULT_STALE_MS in
// lib/agents.js so the client and the server agree on when a session went quiet.
export const HOT_MS = 20_000;
export const WARM_MS = 90_000;

// stroke-dashoffset is a paint property, not a composited one: every frame
// invalidates the whole line's bbox. Element count is cheap, invalidation area
// is not - so cap how many edges can spark at once.
export const MAX_SPARK_EDGES = 24;

// A session with no working subagents has no agent edge to carry traffic, which is
// the common case. It radiates along its own strongest links instead - real work,
// just not attributable to a named agent, so it renders dimmer and slower and never
// lights the far end of the edge. Capped per anchor: a project node has ~9 links and
// the core note ~29, and all of them at once is a firework, not a signal.
export const AMBIENT_EDGES_PER_NODE = 4;

// strongest links first, so the radiating edges are the meaningful ones
const KIND_RANK = { frontmatter: 0, body: 1, tag: 2, scan: 3 };

const DEBOUNCE_MS = 250;   // SSE fires once per hook event, several per second
const SWEEP_MS = 5000;     // decay: a quiet session produces no new snapshot
const PULSE_THROTTLE_MS = 800;

// client twin of normDir() in lib/claude-scan.js - no path.resolve in a browser,
// so cwd and node dirs are both expected already absolute
export function normDir(p) {
  return typeof p === 'string' && p !== ''
    ? p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    : null;
}

function dirContains(parent, child) {
  if (!parent || !child) return false;
  return child === parent || child.startsWith(`${parent}/`);
}

// The vault has no project node of its own - it *is* the graph - so a session
// working in it resolves to the core note that sits at the centre of the rings.
export const VAULT_CENTER_ID = 'README';

// dir -> node id, for project/repo nodes only. Agent, command and routine nodes
// carry the *same* dir as their repo (claude-scan.js:128 sets dir: repoDir), so an
// unfiltered map resolves a session's cwd to a random command node. A real project
// note wins over the synthetic repo anchor, which is what claude-scan does too.
export function buildDirIndex(graphData) {
  const idx = new Map();
  for (const n of graphData?.nodes ?? []) {
    if (n.type !== 'project' && n.type !== 'repo') continue;
    const key = normDir(n.dir);
    if (!key) continue;
    if (!idx.has(key) || n.type === 'project') idx.set(key, n.id);
  }
  // /api/graph carries vaultPath; a real note claiming that dir still wins
  const vault = normDir(graphData?.vaultPath);
  if (vault && !idx.has(vault) && (graphData?.nodes ?? []).some((n) => n.id === VAULT_CENTER_ID)) {
    idx.set(vault, VAULT_CENTER_ID);
  }
  return idx;
}

// a session started in a subdirectory still belongs to its repo
export function resolveAnchor(cwd, idx) {
  let dir = normDir(cwd);
  while (dir) {
    if (idx.has(dir)) return idx.get(dir);
    const cut = dir.lastIndexOf('/');
    if (cut <= 0) return null;
    dir = dir.slice(0, cut);
  }
  return null;
}

// subagent type -> agent node id. Deliberately stricter than the icon lookup in
// main.js: any repo's face of a type will do for an avatar, but lighting up
// SideApp.qa-agent because a DemoApp session spawned a qa-agent would be a lie.
// Same repo, then a global agent, then give up.
export function resolveAgentNode(type, cwd, graphData) {
  if (!type) return null;
  const suffix = `.${type}`;
  const dir = normDir(cwd);
  const candidates = (graphData?.nodes ?? []).filter((n) => n.type === 'agent' && n.id.endsWith(suffix));
  const hit = candidates.find((n) => dirContains(normDir(n.dir), dir))
    ?? candidates.find((n) => n.scope === 'global');
  return hit?.id ?? null;
}

// every scanned item gets exactly one anchor edge (claude-scan.js:134), so the
// graph itself tells us which edge to spark - safer than re-deriving the anchor
// and hoping the key matches.
function scanEdgeIndex(graphData) {
  const byNode = new Map();
  for (const e of graphData?.edges ?? []) {
    if (e.kind !== 'scan') continue;
    byNode.set(e.target, e);
    if (!byNode.has(e.source)) byNode.set(e.source, e);
  }
  return byNode;
}

// node id -> its incident edges, strongest kind first then by key. The order must be
// deterministic: an unstable pick would churn the d3 join every sweep and restart
// every animation, snapping the dots back to the start.
function incidentIndex(graphData) {
  const byNode = new Map();
  const push = (id, e) => {
    if (!byNode.has(id)) byNode.set(id, []);
    byNode.get(id).push(e);
  };
  for (const e of graphData?.edges ?? []) {
    push(e.source, e);
    push(e.target, e);
  }
  for (const list of byNode.values()) {
    list.sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)
      || `${a.source}>${a.target}`.localeCompare(`${b.source}>${b.target}`));
  }
  return byNode;
}

function isLive(s, now) {
  if ((s.kind ?? 'work') !== 'work') return false;   // app startup / housekeeping plumbing
  if (s.status === 'ended' || s.stale) return false;
  return now - s.lastSeen <= WARM_MS;                 // the snapshot itself may have gone quiet
}

/**
 * @returns {{nodes: Map<string, number>,
 *            edges: Map<string, {level: number, ambient: boolean, reverse: boolean}>}}
 *   level 2 = hot (activity within HOT_MS), 1 = warm. `ambient` marks a session
 *   radiating along its own links because it has no working subagent to point at;
 *   `reverse` flips the dots so they always travel *away* from the live node.
 */
export function deriveActivity(snapshot, graphData, now = Date.now()) {
  const nodes = new Map();
  const edges = new Map();
  if (!snapshot || !graphData) return { nodes, edges };

  const idx = buildDirIndex(graphData);
  const scanEdges = scanEdgeIndex(graphData);
  const incident = incidentIndex(graphData);
  const bump = (id, level) => { if (id) nodes.set(id, Math.max(nodes.get(id) ?? 0, level)); };
  const spark = (e, from, level, ambient) => {
    const key = `${e.source}>${e.target}`; // matches edgeKey() in graph-view.js
    const prev = edges.get(key);
    // a real agent edge always outranks an ambient one on the same link
    if (prev && !prev.ambient && ambient) return;
    const merged = prev && prev.ambient === ambient ? Math.max(prev.level, level) : level;
    edges.set(key, {
      level: merged,
      ambient,
      reverse: e.target === from, // dots leave the live node, whichever end it is
    });
  };

  for (const s of snapshot.sessions ?? []) {
    if (!isLive(s, now)) continue;
    const level = now - s.lastSeen < HOT_MS ? 2 : 1;
    const anchor = resolveAnchor(s.cwd, idx);
    bump(anchor, level);

    let attributed = 0;
    for (const a of s.subagents ?? []) {
      if (a.status !== 'working') continue;
      const agentId = resolveAgentNode(a.type, s.cwd, graphData);
      if (!agentId) continue;
      bump(agentId, level);
      const e = scanEdges.get(agentId);
      if (!e) continue;
      const far = e.source === agentId ? e.target : e.source;
      bump(far, level);
      spark(e, far, level, false);
      attributed += 1;
    }

    // nothing to attribute the work to - radiate from the session's own node. The far
    // end is deliberately NOT bumped: those neighbours are context, not running work.
    if (attributed === 0 && anchor) {
      for (const e of (incident.get(anchor) ?? []).slice(0, AMBIENT_EDGES_PER_NODE)) {
        spark(e, anchor, level, true);
      }
    }
  }

  if (edges.size <= MAX_SPARK_EDGES) return { nodes, edges };
  // real agent traffic keeps its slot before any ambient radiation does
  const kept = [...edges]
    .sort((a, b) => Number(a[1].ambient) - Number(b[1].ambient)
      || b[1].level - a[1].level
      || a[0].localeCompare(b[0]))
    .slice(0, MAX_SPARK_EDGES);
  return { nodes, edges: new Map(kept) };
}

// A stable string for "the live picture did not change", so the decay sweep can
// run every 5s without churning the d3 joins underneath the animations.
export function signature(act) {
  const nodes = [...act.nodes].map(([id, l]) => `${id}:${l}`).sort().join(',');
  const edges = [...act.edges]
    .map(([k, v]) => `${k}:${v.level}${v.ambient ? 'a' : ''}${v.reverse ? 'r' : ''}`)
    .sort().join(',');
  return `${nodes}|${edges}`;
}

const subKey = (a) => `${a.type}|${a.startedAt}`;

/**
 * One-shot events worth a ripple, by diffing two consecutive snapshots. Kept
 * separate from deriveActivity because a toolCount bump changes nothing in the
 * steady-state picture and would be swallowed by the signature guard.
 * @param prev Map<sessionId, {toolCount, subKeys: Set}> - carry the returned `next` forward
 * @returns {{events: {cwd: string, agentType: string|null}[], next: Map}}
 */
export function diffPulses(prev, snapshot) {
  const events = [];
  const next = new Map();
  for (const s of snapshot?.sessions ?? []) {
    if ((s.kind ?? 'work') !== 'work') continue;
    const working = (s.subagents ?? []).filter((a) => a.status === 'working');
    next.set(s.sessionId, {
      toolCount: s.toolCount ?? 0,
      subKeys: new Set(working.map(subKey)),
    });
    const was = prev.get(s.sessionId);
    if (!was) {
      events.push({ cwd: s.cwd, agentType: null }); // first sight of this session
      for (const a of working) events.push({ cwd: s.cwd, agentType: a.type });
      continue;
    }
    for (const a of working) {
      if (!was.subKeys.has(subKey(a))) events.push({ cwd: s.cwd, agentType: a.type });
    }
    if ((s.toolCount ?? 0) > was.toolCount) events.push({ cwd: s.cwd, agentType: null });
  }
  return { events, next };
}

// --- controller ----------------------------------------------------------

export function createAgentActivity({ view, getGraphData, now = Date.now }) {
  let snapshot = null;
  let sig = null;
  let prevSessions = new Map();
  const lastPulseAt = new Map();
  let timer = null;

  // re-derive from the *last* snapshot against the current clock: hot -> warm ->
  // gone has to happen client-side, since server.js only broadcasts on a hook event
  function reapply() {
    const graphData = getGraphData();
    if (!graphData) return null;
    const act = deriveActivity(snapshot, graphData, now());
    const next = signature(act);
    if (next !== sig) {
      sig = next;
      view.setAgentActivity(act);
    }
    return act;
  }

  function flush() {
    const graphData = getGraphData();
    const act = reapply();
    const { events, next } = diffPulses(prevSessions, snapshot);
    prevSessions = next;
    if (!act || !graphData) return;

    const idx = buildDirIndex(graphData);
    const t = now();
    const ids = [];
    for (const ev of events) {
      const id = ev.agentType
        ? resolveAgentNode(ev.agentType, ev.cwd, graphData)
        : resolveAnchor(ev.cwd, idx);
      if (!id || !act.nodes.has(id)) continue; // never ping a node that isn't live
      if (t - (lastPulseAt.get(id) ?? 0) < PULSE_THROTTLE_MS) continue;
      lastPulseAt.set(id, t);
      ids.push(id);
    }
    if (ids.length) view.pulseNodes(ids);
  }

  function onSnapshot(next) {
    snapshot = next;
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  }

  // setInterval, never rAF - a hidden pane pauses rAF and the decay would stall
  setInterval(reapply, SWEEP_MS);

  return {
    onSnapshot,
    reapply,
    get snapshot() { return snapshot; },
  };
}
