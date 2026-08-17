// Pure graph builder: notes[] (+ skills[]) -> { nodes, edges, warnings }.
// Undirected, deduped edges; ghost nodes for unresolved wikilink targets;
// application nodes derived from configured tags.

export function buildGraph({ notes, skills = [], warnings = [] }, opts = {}) {
  const applicationTags = opts.applicationTags ?? [];
  const warn = [...warnings];
  const all = [...notes, ...skills];

  const noteById = new Map();
  const idByPath = new Map();
  for (const n of all) {
    if (noteById.has(n.id)) {
      warn.push(`duplicate note id "${n.id}" (${noteById.get(n.id).path} vs ${n.path})`);
    }
    noteById.set(n.id, n);
    idByPath.set(n.path, n.id);
    if (n.name !== n.id && n.type !== 'template') {
      warn.push(`frontmatter name "${n.name}" != filename stem "${n.id}" (${n.path})`);
    }
  }

  // dedupe on the sorted pair: the graph renders undirected (showArrow: false)
  const edgeMap = new Map();
  const KIND_RANK = { frontmatter: 3, body: 2, tag: 1 };
  const addEdge = (a, b, kind) => {
    if (a === b) return;
    const [s, t] = a < b ? [a, b] : [b, a];
    const key = `${s} ${t}`;
    const e = edgeMap.get(key);
    if (e) {
      e.count += 1;
      if (KIND_RANK[kind] > KIND_RANK[e.kind]) e.kind = kind;
    } else {
      edgeMap.set(key, { source: s, target: t, kind, count: 1 });
    }
  };

  // markdown links resolve by vault-relative path first, then basename stem;
  // they never create ghosts (only wikilinks express "note worth writing")
  const resolveDocLink = (target) => {
    if (idByPath.has(target)) return idByPath.get(target);
    const stem = target.split('/').pop().replace(/\.md$/i, '');
    return noteById.has(stem) ? stem : null;
  };

  for (const n of notes) {
    // template bodies are placeholder [[slug]] noise; keep the nodes, drop their links
    if (n.type === 'template') continue;
    for (const target of n.projectLinks) addEdge(n.id, target, 'frontmatter');
    for (const target of n.bodyLinks) addEdge(n.id, target, 'body');
    for (const target of n.docLinks ?? []) {
      const id = resolveDocLink(target);
      if (id) addEdge(n.id, id, 'body');
    }
    // root docs reference skills as inline-code paths, not links - scan for them
    if (n.folder === null && n.rawBody) {
      for (const m of n.rawBody.matchAll(/skills[\\/]([\w-]+)[\\/]SKILL\.md/g)) {
        if (noteById.get(m[1])?.type === 'routine') addEdge(n.id, m[1], 'body');
      }
    }
  }

  for (const s of skills) {
    for (const target of s.bodyLinks) {
      if (noteById.has(target)) addEdge(s.id, target, 'body'); // resolved only - no skill ghosts
    }
    for (const target of s.docLinks ?? []) {
      const id = resolveDocLink(target);
      if (id) addEdge(s.id, id, 'body');
    }
    // skill bodies name their targets in code spans ("append to inbox.md") -
    // scan the raw body for known note stems
    if (s.rawBody) {
      for (const n of all) {
        if (n.id === s.id || n.type === 'template') continue;
        if (new RegExp(`\\b${escapeRegExp(n.id)}\\.md\\b`).test(s.rawBody)) {
          addEdge(s.id, n.id, 'body');
        }
      }
    }
  }

  const nodes = all.map((n) => ({
    id: n.id,
    type: n.type,
    folder: n.folder,
    description: n.description,
    tags: n.tags,
    updated: n.updated,
    status: n.status ?? null,
    dir: n.dir ?? null,
    degree: 0,
  }));

  // application nodes: one per configured tag that real notes actually carry
  for (const tag of applicationTags) {
    const members = notes.filter((n) => n.type !== 'template' && n.tags.includes(tag));
    if (members.length === 0) continue;
    const appId = noteById.has(tag) ? `app-${tag}` : tag;
    nodes.push({
      id: appId, type: 'application', folder: null,
      description: `notes tagged #${tag}`, tags: [tag], updated: null,
      status: null, dir: null, degree: 0,
    });
    for (const n of members) addEdge(appId, n.id, 'tag');
  }
  const edges = [...edgeMap.values()];

  // ghost nodes for wikilink targets that do not resolve (hideUnresolved: false)
  const known = new Set(nodes.map((n) => n.id));
  const ghosts = new Map();
  for (const e of edges) {
    for (const end of [e.source, e.target]) {
      if (!known.has(end) && !ghosts.has(end)) {
        ghosts.set(end, {
          id: end, type: 'unresolved', folder: null,
          description: null, tags: [], updated: null,
          status: null, dir: null, degree: 0,
        });
      }
    }
  }
  nodes.push(...ghosts.values());

  const degree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    degree.set(e.source, degree.get(e.source) + 1);
    degree.set(e.target, degree.get(e.target) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id);

  return { nodes, edges, warnings: warn };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
