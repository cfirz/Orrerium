import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMBIENT_EDGES_PER_NODE,
  HOT_MS,
  MAX_SPARK_EDGES,
  SUBAGENT_WARM_MS,
  WARM_MS,
  buildDirIndex,
  deriveActivity,
  diffPulses,
  normDir,
  resolveAgentNode,
  resolveAnchor,
  signature,
} from '../public/js/agent-activity.js';

const NOW = 1_700_000_000_000;

// mirrors what /api/graph returns after mergeClaudeAssets: the agent and command
// nodes carry the SAME dir as their project, which is the whole point of the
// project/repo filter in buildDirIndex
const GRAPH = {
  nodes: [
    { id: 'demo-app', type: 'project', dir: 'C:/code/DemoApp', degree: 3 },
    { id: 'DemoApp.qa-agent', type: 'agent', dir: 'C:/code/DemoApp', scope: 'repo' },
    { id: 'DemoApp.commit-push', type: 'command', dir: 'C:/code/DemoApp', scope: 'repo' },
    { id: 'side-app', type: 'repo', dir: 'C:/code/SideApp' },
    { id: 'SideApp.qa-agent', type: 'agent', dir: 'C:/code/SideApp', scope: 'repo' },
    { id: 'user.Explore', type: 'agent', dir: null, scope: 'global' },
    { id: 'some-lesson', type: 'lesson', dir: null },
  ],
  edges: [
    { source: 'demo-app', target: 'DemoApp.qa-agent', kind: 'scan', count: 1 },
    { source: 'demo-app', target: 'DemoApp.commit-push', kind: 'scan', count: 1 },
    { source: 'side-app', target: 'SideApp.qa-agent', kind: 'scan', count: 1 },
    { source: 'demo-app', target: 'some-lesson', kind: 'frontmatter', count: 2 },
  ],
};

function session(extra = {}) {
  return {
    sessionId: 's1',
    project: 'DemoApp',
    cwd: 'C:/code/DemoApp',
    startedAt: NOW - 60_000,
    lastSeen: NOW,
    status: 'active',
    activity: 'Running: Read',
    toolCount: 4,
    promptCount: 1,
    errorCount: 0,
    kind: 'work',
    stale: false,
    subagents: [],
    ...extra,
  };
}

const working = (type, startedAt = NOW - 5000) => ({ type, description: 'd', status: 'working', startedAt, endedAt: null });
const snap = (...sessions) => ({ generatedAt: new Date(NOW).toISOString(), sessions });

test('normDir normalizes separators, trailing slashes and case', () => {
  assert.equal(normDir('C:\\code\\DemoApp\\'), 'c:/code/demoapp');
  assert.equal(normDir(''), null);
  assert.equal(normDir(undefined), null);
});

test('buildDirIndex skips the agent/command nodes that share their repo dir', () => {
  const idx = buildDirIndex(GRAPH);
  assert.equal(idx.size, 2);
  assert.equal(idx.get('c:/code/demoapp'), 'demo-app'); // not DemoApp.commit-push
  assert.equal(idx.get('c:/code/sideapp'), 'side-app');
});

test('buildDirIndex maps the vault root itself to the core note', () => {
  const graph = { ...GRAPH, vaultPath: 'C:/My Vaults/Brain', nodes: [...GRAPH.nodes, { id: 'README', type: 'root' }] };
  const idx = buildDirIndex(graph);
  assert.equal(idx.get('c:/my vaults/brain'), 'README');
  // a session anywhere under the vault resolves, and Orrerium next door does not collide
  assert.equal(resolveAnchor('C:/My Vaults/Brain/lessons', idx), 'README');
  assert.equal(resolveAnchor('C:/My Vaults/Orrerium', idx), null);
  // no core note in the graph -> no phantom entry
  assert.equal(buildDirIndex({ ...GRAPH, vaultPath: 'C:/My Vaults/Brain' }).get('c:/my vaults/brain'), undefined);
});

test('buildDirIndex prefers a real project note over the synthetic repo anchor', () => {
  const idx = buildDirIndex({
    nodes: [
      { id: 'repo-thing', type: 'repo', dir: 'C:/Code/Thing' },
      { id: 'thing', type: 'project', dir: 'C:/Code/Thing' },
    ],
  });
  assert.equal(idx.get('c:/code/thing'), 'thing');
});

test('resolveAnchor walks up from a subdirectory and gives up outside any repo', () => {
  const idx = buildDirIndex(GRAPH);
  assert.equal(resolveAnchor('C:/code/DemoApp/Assets/Scripts', idx), 'demo-app');
  assert.equal(resolveAnchor('C:\\code\\DemoApp', idx), 'demo-app');
  assert.equal(resolveAnchor('C:/Somewhere/Else', idx), null);
  assert.equal(resolveAnchor(null, idx), null);
});

test('resolveAgentNode prefers the same repo, then a global agent, then gives up', () => {
  const cwd = 'C:/code/DemoApp/Assets';
  assert.equal(resolveAgentNode('qa-agent', cwd, GRAPH), 'DemoApp.qa-agent'); // not SideApp's
  assert.equal(resolveAgentNode('Explore', cwd, GRAPH), 'user.Explore');
  assert.equal(resolveAgentNode('no-such-agent', cwd, GRAPH), null);
  assert.equal(resolveAgentNode(null, cwd, GRAPH), null);
});

test('deriveActivity lights the anchor and sparks the real scan edge', () => {
  const act = deriveActivity(snap(session({ subagents: [working('qa-agent')] })), GRAPH, NOW);
  assert.deepEqual([...act.nodes].sort(), [['DemoApp.qa-agent', 2], ['demo-app', 2]]);
  // key orientation must match edgeKey() in graph-view.js and the scan edge above
  assert.deepEqual([...act.edges.keys()], ['demo-app>DemoApp.qa-agent']);
});

test('deriveActivity: a session with no subagents radiates along its own links', () => {
  const act = deriveActivity(snap(session()), GRAPH, NOW);
  // only the session's own node is live - the far ends are context, not running work
  assert.deepEqual([...act.nodes.keys()], ['demo-app']);
  assert.deepEqual([...act.edges.keys()], [
    'demo-app>some-lesson',              // frontmatter outranks scan
    'demo-app>DemoApp.commit-push',
    'demo-app>DemoApp.qa-agent',
  ]);
  assert.equal([...act.edges.values()].every((v) => v.ambient && !v.reverse), true);
});

test('deriveActivity: ambient radiation is capped per anchor and stays deterministic', () => {
  const graph = { nodes: [...GRAPH.nodes], edges: [...GRAPH.edges] };
  for (let i = 0; i < 8; i += 1) {
    graph.nodes.push({ id: `note-${i}`, type: 'lesson', dir: null });
    graph.edges.push({ source: 'demo-app', target: `note-${i}`, kind: 'frontmatter', count: 1 });
  }
  const once = deriveActivity(snap(session()), graph, NOW);
  const twice = deriveActivity(snap(session()), graph, NOW);
  assert.equal(once.edges.size, AMBIENT_EDGES_PER_NODE);
  assert.deepEqual([...once.edges.keys()], [...twice.edges.keys()]); // stable, or the join churns
});

test('deriveActivity: ambient dots travel away from the live node on either end', () => {
  const graph = {
    nodes: [{ id: 'thing', type: 'project', dir: 'C:/Code/Thing' }, { id: 'inbound', type: 'lesson' }],
    edges: [{ source: 'inbound', target: 'thing', kind: 'frontmatter', count: 1 }],
  };
  const act = deriveActivity(snap(session({ cwd: 'C:/Code/Thing' })), graph, NOW);
  assert.equal(act.edges.get('inbound>thing').reverse, true); // anchor is the target
});

test('deriveActivity: attributable agent traffic replaces ambient radiation', () => {
  const act = deriveActivity(snap(session({ subagents: [working('qa-agent')] })), GRAPH, NOW);
  assert.deepEqual([...act.edges.keys()], ['demo-app>DemoApp.qa-agent']);
  assert.equal(act.edges.get('demo-app>DemoApp.qa-agent').ambient, false);
});

test('deriveActivity: an agent with no scan edge lights its node, and the session still radiates', () => {
  const act = deriveActivity(snap(session({ subagents: [working('Explore')] })), GRAPH, NOW);
  assert.deepEqual([...act.nodes.keys()].sort(), ['demo-app', 'user.Explore']);
  // nothing to draw between them, so the anchor falls back to ambient
  assert.equal([...act.edges.values()].every((v) => v.ambient), true);
});

test('deriveActivity: a finished subagent is not attributable work', () => {
  const done = { type: 'qa-agent', description: 'd', status: 'done', startedAt: NOW - 9000, endedAt: NOW - 1000 };
  const act = deriveActivity(snap(session({ subagents: [done] })), GRAPH, NOW);
  assert.deepEqual([...act.nodes.keys()], ['demo-app']);
  assert.equal([...act.edges.values()].every((v) => v.ambient), true);
});

test('deriveActivity: hot within HOT_MS, warm up to WARM_MS, gone after', () => {
  const at = (age) => deriveActivity(snap(session({ lastSeen: NOW - age })), GRAPH, NOW);
  assert.equal(at(HOT_MS - 1).nodes.get('demo-app'), 2);
  assert.equal(at(HOT_MS + 1).nodes.get('demo-app'), 1);
  assert.equal(at(WARM_MS + 1).nodes.size, 0);
});

test('deriveActivity excludes ended, stale and non-work sessions', () => {
  const gone = [
    session({ status: 'ended' }),
    session({ stale: true }),
    session({ kind: 'startup' }),
    session({ kind: 'housekeeping' }),
  ];
  for (const s of gone) assert.equal(deriveActivity(snap(s), GRAPH, NOW).nodes.size, 0);
  assert.equal(deriveActivity(null, GRAPH, NOW).nodes.size, 0);
  assert.equal(deriveActivity(snap(session()), null, NOW).nodes.size, 0);
});

test('deriveActivity takes the hottest session when two share a node', () => {
  const act = deriveActivity(snap(
    session({ sessionId: 'cold', lastSeen: NOW - HOT_MS - 1 }),
    session({ sessionId: 'hot', lastSeen: NOW }),
  ), GRAPH, NOW);
  assert.equal(act.nodes.get('demo-app'), 2);
});

test('deriveActivity caps concurrent spark edges', () => {
  const many = { nodes: [...GRAPH.nodes], edges: [...GRAPH.edges] };
  const subagents = [];
  for (let i = 0; i < MAX_SPARK_EDGES + 6; i += 1) {
    many.nodes.push({ id: `DemoApp.a${i}`, type: 'agent', dir: 'C:/code/DemoApp', scope: 'repo' });
    many.edges.push({ source: 'demo-app', target: `DemoApp.a${i}`, kind: 'scan', count: 1 });
    subagents.push(working(`a${i}`));
  }
  const act = deriveActivity(snap(session({ subagents })), many, NOW);
  assert.equal(act.edges.size, MAX_SPARK_EDGES);
  // real agent traffic keeps every slot; ambient radiation is dropped first
  assert.equal([...act.edges.values()].some((v) => v.ambient), false);
});

test('deriveActivity: the cap drops ambient radiation before real agent traffic', () => {
  const graph = { nodes: [...GRAPH.nodes], edges: [...GRAPH.edges] };
  // a second live session in another repo, radiating with nothing to attribute
  for (let i = 0; i < MAX_SPARK_EDGES + 4; i += 1) {
    graph.nodes.push({ id: `k-${i}`, type: 'lesson', dir: null });
    graph.edges.push({ source: 'side-app', target: `k-${i}`, kind: 'frontmatter', count: 1 });
  }
  const act = deriveActivity(snap(
    session({ sessionId: 'real', subagents: [working('qa-agent')] }),
    session({ sessionId: 'ambient', cwd: 'C:/code/SideApp' }),
  ), graph, NOW);
  assert.equal(act.edges.get('demo-app>DemoApp.qa-agent').ambient, false);
});

test('signature is stable for an unchanged picture', () => {
  const a = deriveActivity(snap(session({ subagents: [working('qa-agent')] })), GRAPH, NOW);
  const b = deriveActivity(snap(session({ subagents: [working('qa-agent')] })), GRAPH, NOW);
  assert.equal(signature(a), signature(b));
  const hotter = deriveActivity(snap(session({ lastSeen: NOW - HOT_MS - 1, subagents: [working('qa-agent')] })), GRAPH, NOW);
  assert.notEqual(signature(a), signature(hotter));
});

test('diffPulses fires on first sight, new subagents and tool bursts - never twice', () => {
  const first = snap(session({ toolCount: 4 }));
  let { events, next } = diffPulses(new Map(), first);
  assert.deepEqual(events.map((e) => e.agentType), [null]); // the session itself

  ({ events, next } = diffPulses(next, first)); // identical snapshot
  assert.deepEqual(events, []);

  const spawned = snap(session({ toolCount: 5, subagents: [working('qa-agent', NOW - 100)] }));
  ({ events, next } = diffPulses(next, spawned));
  assert.deepEqual(events.map((e) => e.agentType).sort(), ['qa-agent', null].sort());

  ({ events, next } = diffPulses(next, spawned));
  assert.deepEqual(events, []);

  // the same subagent finishing is not an event; a second one starting is
  const second = snap(session({
    toolCount: 5,
    subagents: [working('qa-agent', NOW - 100), working('Explore', NOW - 50)],
  }));
  ({ events } = diffPulses(next, second));
  assert.deepEqual(events.map((e) => e.agentType), ['Explore']);
});

test('diffPulses ignores app plumbing sessions', () => {
  const { events } = diffPulses(new Map(), snap(session({ kind: 'startup' }), session({ kind: 'housekeeping' })));
  assert.deepEqual(events, []);
});

// --- sessions waiting on subagents ---------------------------------------
// The case the ordinary staleness window gets wrong: a subagent's tool calls are
// never logged under the parent session id, so an orchestrator with agents in
// flight has a frozen `lastSeen` and looks quieter than anything else on the graph.

test('a session waiting on subagents stays live past WARM_MS', () => {
  const waiting = session({ lastSeen: NOW - 10 * 60_000, subagents: [working('qa-agent', NOW - 10 * 60_000)] });
  const act = deriveActivity(snap(waiting), GRAPH, NOW);
  assert.equal(act.nodes.get('demo-app'), 1); // warm, not hot - it genuinely has not spoken
  assert.equal(act.nodes.get('DemoApp.qa-agent'), 1);
  assert.equal(act.subagents.get('DemoApp.qa-agent'), 1);

  // the same session with no subagent in flight is dark, as before
  const quiet = session({ lastSeen: NOW - 10 * 60_000 });
  assert.equal(deriveActivity(snap(quiet), GRAPH, NOW).nodes.size, 0);
});

test('the subagent lease is a lease: a lost SubagentStop stops claiming work', () => {
  const abandoned = session({ lastSeen: NOW - SUBAGENT_WARM_MS - 1, subagents: [working('qa-agent')] });
  assert.equal(deriveActivity(snap(abandoned), GRAPH, NOW).nodes.size, 0);
});

test('a delegating session ignores the server stale flag, a quiet one obeys it', () => {
  const flagged = session({ stale: true, lastSeen: NOW - 5 * 60_000, subagents: [working('qa-agent')] });
  assert.equal(deriveActivity(snap(flagged), GRAPH, NOW).nodes.get('demo-app'), 1);

  const quiet = session({ stale: true, lastSeen: NOW - 5000 });
  assert.equal(deriveActivity(snap(quiet), GRAPH, NOW).nodes.size, 0);
});

test('subagent types with no node of their own are counted on the orchestrator', () => {
  // general-purpose/Plan are built in: no .claude/agents/*.md file, so no node
  const s = session({ subagents: [working('general-purpose'), working('Plan'), working('qa-agent')] }); // Plan has no node either
  const act = deriveActivity(snap(s), GRAPH, NOW);
  assert.equal(act.subagents.get('demo-app'), 2);          // the two unnamed ones
  assert.equal(act.subagents.get('DemoApp.qa-agent'), 1);  // the one with a node
  // one attributable agent, so the traffic is the real scan edge - not ambient
  assert.equal(act.edges.get('demo-app>DemoApp.qa-agent').ambient, false);
});

test('a session whose subagents are all nodeless still radiates, and counts them', () => {
  const s = session({ subagents: [working('general-purpose'), working('statusline-setup')] });
  const act = deriveActivity(snap(s), GRAPH, NOW);
  assert.equal(act.subagents.get('demo-app'), 2);
  // nothing attributable, so it radiates along its own links as ambient traffic
  assert.ok(act.edges.size > 0);
  assert.ok([...act.edges.values()].every((e) => e.ambient));
});

test('global agents still resolve, and are not double-counted on the anchor', () => {
  const s = session({ subagents: [working('Explore')] }); // user.Explore, scope: global
  const act = deriveActivity(snap(s), GRAPH, NOW);
  assert.equal(act.subagents.get('user.Explore'), 1);
  assert.equal(act.subagents.has('demo-app'), false);
});

test('signature changes when a subagent count changes but nothing else does', () => {
  const one = session({ subagents: [working('general-purpose', NOW - 5000)] });
  const two = session({ subagents: [working('general-purpose', NOW - 5000), working('Plan', NOW - 4000)] });
  const a = deriveActivity(snap(one), GRAPH, NOW);
  const b = deriveActivity(snap(two), GRAPH, NOW);
  assert.deepEqual([...a.nodes], [...b.nodes]); // same nodes, same levels
  assert.notEqual(signature(a), signature(b));
});

test('a subagent pinned working by a lost stop stops counting once its lease is up', () => {
  const pinned = working('qa-agent', NOW - SUBAGENT_WARM_MS - 1);
  // nothing else keeps this session alive, so it goes dark like any quiet one
  const quiet = session({ lastSeen: NOW - 5 * 60_000, subagents: [pinned] });
  const act = deriveActivity(snap(quiet), GRAPH, NOW);
  assert.equal(act.nodes.size, 0);
  assert.equal(act.subagents.size, 0);

  // and a session that IS live does not light the pinned agent's node either
  const busy = session({ lastSeen: NOW - 1000, subagents: [pinned] });
  const act2 = deriveActivity(snap(busy), GRAPH, NOW);
  assert.equal(act2.nodes.get('demo-app'), 2);
  assert.equal(act2.nodes.has('DemoApp.qa-agent'), false);
  assert.equal(act2.subagents.size, 0);
});
