import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVault, parseSkills } from '../lib/vault.js';
import { buildGraph } from '../lib/graph.js';
import { createAgentTracker, isSubagentTool, sanitizeEvents } from '../lib/agents.js';
import { summarize } from '../lib/flows.js';
import { buildStats } from '../lib/stats.js';
import { DEMO_SOURCE, LOOP_MS, anchorsFromGraph, demoHistory, demoLoop, shouldRunDemo } from '../lib/demo.js';
import { createDemoFeeder } from '../lib/demo-feeder.js';
import { deriveActivity } from '../public/js/agent-activity.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STARTER = path.join(ROOT, 'starter-vault');
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // the /api/flows/:id gate in server.js
const NOW = Date.UTC(2026, 9, 12, 10, 30, 0);
const DAY = 86_400_000;

// the graph a fresh clone serves: starter vault, nothing scanned
function starterGraph() {
  const parsed = parseVault(STARTER);
  const { skills } = parseSkills(STARTER);
  return {
    vaultPath: STARTER.replaceAll('\\', '/'),
    ...buildGraph({ notes: parsed.notes, skills, warnings: [] }, { applicationTags: ['git', 'python'] }),
  };
}

test('shouldRunDemo: only the bundled vault, only before any real event', () => {
  const base = { demo: true, vaultPath: STARTER, root: ROOT, hasEvents: false };
  assert.equal(shouldRunDemo(base), true);
  assert.equal(shouldRunDemo({ ...base, demo: false }), false);
  assert.equal(shouldRunDemo({ ...base, hasEvents: true }), false);
  assert.equal(shouldRunDemo({ ...base, vaultPath: path.join(ROOT, 'test', 'fixtures', 'vault') }), false);
  assert.equal(shouldRunDemo({ ...base, vaultPath: `${STARTER}${path.sep}` }), true); // trailing slash, same dir
});

test('anchorsFromGraph takes the literal project dirs and the vault path', () => {
  const anchors = anchorsFromGraph(starterGraph());
  assert.deepEqual(anchors.projects, {
    'orbit-tracker': '~/code/orbit-tracker',
    'pixel-garden': '~/code/pixel-garden',
    'recipe-box': '~/code/recipe-box',
  });
  assert.equal(anchors.vaultDir, STARTER.replaceAll('\\', '/'));
});

test('demoLoop: sorted, inside its loop, every spawn typed, ids slug-safe', () => {
  const anchors = anchorsFromGraph(starterGraph());
  const events = demoLoop({ startTs: NOW, loopIndex: 0, anchors });
  assert.ok(events.length > 40);
  for (let i = 1; i < events.length; i++) assert.ok(events[i - 1].ts <= events[i].ts);
  assert.ok(events.every((e) => e.ts >= NOW && e.ts < NOW + LOOP_MS));
  assert.ok(events.every((e) => SLUG_RE.test(e.sessionId)));
  const spawns = events.filter((e) => e.event === 'PreToolUse' && isSubagentTool(e.tool));
  assert.equal(spawns.length, 4); // A: 2 Explore + Plan, B: one general-purpose
  assert.ok(spawns.every((e) => e.input.subagent_type && typeof e.input.run_in_background === 'boolean'));
  // projects rotate through the roles loop by loop
  const projectsIn = (loop) => [...new Set(demoLoop({ startTs: NOW, loopIndex: loop, anchors }).map((e) => e.cwd))];
  assert.notDeepEqual(projectsIn(0), projectsIn(1));
  // deterministic
  assert.deepEqual(demoLoop({ startTs: NOW, loopIndex: 0, anchors }), events);
});

test('demoHistory: stable all day, log-shaped, fills Flows and Stats', () => {
  const anchors = anchorsFromGraph(starterGraph());
  const history = demoHistory({ now: NOW, anchors });
  assert.deepEqual(demoHistory({ now: NOW + 3 * 3_600_000, anchors }), history); // same UTC day
  const midnight = Date.UTC(2026, 9, 12);
  assert.ok(history.every((e) => e.ts < midnight && e.ts >= midnight - 7 * DAY));
  assert.ok(history.every((e) => e.source === DEMO_SOURCE && SLUG_RE.test(e.sessionId)));
  // already canonical: sanitizing again changes nothing
  for (const e of history.slice(0, 50)) {
    const { source, ...raw } = e;
    assert.deepEqual(sanitizeEvents(raw, { source, now: () => e.ts })[0], e);
  }
  const sessions = summarize(history);
  assert.ok(sessions.length >= 7, `expected >=7 flows, got ${sessions.length}`);
  const stats = buildStats({ events: history, now: () => NOW });
  assert.ok(stats.days.filter((d) => d.toolCalls > 0).length >= 7);
  assert.ok(stats.totals.subagentSpawns > 0);
  assert.ok(stats.totals.errors > 0);
});

test('demoLoop lights the starter graph: projects, subagent rings, the vault core', () => {
  const graph = starterGraph();
  const anchors = anchorsFromGraph(graph);
  const tracker = createAgentTracker({ dataDir: null, now: () => NOW + 60_000 });
  for (const e of demoLoop({ startTs: NOW, loopIndex: 0, anchors })) {
    if (e.ts <= NOW + 60_000) tracker.record(e, DEMO_SOURCE);
  }
  const { nodes, edges, subagents } = deriveActivity(tracker.snapshot(), graph, NOW + 60_000);
  // loop 0: A = orbit-tracker delegating, B = recipe-box fixing, V = the vault
  assert.ok(nodes.has('orbit-tracker'));
  assert.ok(nodes.has('recipe-box'));
  assert.ok(nodes.has('README'));
  assert.equal(subagents.get('orbit-tracker'), 2); // 2 Explore + Plan, one closed by the 58s stop
  assert.equal(subagents.get('recipe-box'), 1); // the blocking general-purpose agent
  assert.ok(edges.size > 0, 'ambient sparks along the live nodes\' links');
});

// a fake clock and timer queue: the feeder runs without real waiting
function fakeTime(start) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const handle = { fn, at: t + ms };
      timers.push(handle);
      return handle;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms) {
      const until = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) break;
        timers.shift();
        t = Math.max(t, next.at); // an overdue timer fires late, never in the past
        next.fn();
      }
      t = until;
    },
    // the machine sleeps: the clock moves, nothing fires
    jump(ms) {
      t += ms;
    },
    pending: () => timers.length,
  };
}

test('feeder: primes a minute at once, keeps playing, stops dead', () => {
  const anchors = anchorsFromGraph(starterGraph());
  const clock = fakeTime(NOW);
  const snapshots = [];
  const feeder = createDemoFeeder({ anchors, onChange: (s) => snapshots.push(s), ...clock });
  clock.advance(0);
  assert.equal(snapshots.length, 1, 'the primed minute lands as one broadcast');
  assert.equal(snapshots[0].demo, true);
  assert.equal(snapshots[0].sessions.filter((s) => s.status === 'active').length, 3);

  clock.advance(LOOP_MS * 2); // through a loop boundary
  assert.ok(snapshots.length > 10);
  assert.ok(feeder.events().length > 0);
  assert.ok(summarize(feeder.events()).length >= 7);

  feeder.stop();
  assert.equal(clock.pending(), 0);
  const count = snapshots.length;
  clock.advance(LOOP_MS * 3);
  assert.equal(snapshots.length, count, 'nothing broadcasts after stop()');
});

test('feeder: a long sleep restarts the loop instead of replaying the backlog', () => {
  const anchors = anchorsFromGraph(starterGraph());
  const clock = fakeTime(NOW);
  let broadcasts = 0;
  const feeder = createDemoFeeder({ anchors, onChange: () => { broadcasts += 1; }, ...clock });
  clock.advance(0);
  const before = broadcasts;
  clock.jump(3_600_000); // an hour asleep, then the one overdue timer fires
  clock.advance(0);
  assert.equal(broadcasts - before, 1, 'one catch-up tick, not thirty loops of backlog');
  // the fresh loop starts now: its first session opens at the wake-up instant
  const latest = feeder.snapshot().sessions[0];
  assert.equal(latest.startedAt, clock.now());
  feeder.stop();
});
