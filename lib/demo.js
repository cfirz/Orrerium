// Demo replay: on a first launch - the bundled starter vault, no hook event
// ever logged - the observatory would have nothing to observe. This scripts a
// believable morning of agent work over the starter projects so the graph
// lights up and the Agents, Flows and Stats panels have something to show
// until the first real session reports (lib/demo-feeder.js plays it; the
// server stops it on the first real hook event).
//
// Pure and deterministic - no fs, no timers, no Math.random: the same inputs
// give the same events, which is what makes it testable. Session cwds are the
// starter projects' literal `dir` strings (`~/code/orbit-tracker`): the client
// matches cwd to a node's dir by lowercased path prefix with no ~ expansion
// (agent-activity.js normDir/resolveAnchor), so anything else lights nothing.
// The starter vault has no .claude/agents files, so every subagent here is a
// built-in type - it rides its project's subagent ring, not an agent node.
import path from 'node:path';
import { sanitizeEvents } from './agents.js';

export const DEMO_SOURCE = 'demo';
export const LOOP_MS = 120_000;
export const HISTORY_DAYS = 7;

const DAY_MS = 86_400_000;
const ORDER = ['orbit-tracker', 'recipe-box', 'pixel-garden'];

// per-project flavour, matched to what each starter note says the project is
const FLAVOUR = {
  'orbit-tracker': {
    ask: 'Add a pass-prediction overlay to the sky map',
    fix: 'Passes near midnight UTC land on the wrong day',
    files: ['lib/tle.js', 'lib/passes.js', 'public/sky-map.js'],
    grep: 'propagate(',
    test: 'node --test',
    explore: ['Map how TLE parsing feeds the propagator', 'Find where the sky map redraws'],
    plan: 'Plan the overlay layer',
    debug: 'Reproduce the midnight pass bug',
  },
  'recipe-box': {
    ask: 'Import recipes from a folder of markdown files',
    fix: 'Recipes saved from Notepad fail to import',
    files: ['recipe_box/importer.py', 'recipe_box/frontmatter.py', 'recipe_box/cli.py'],
    grep: 'def parse_frontmatter',
    test: 'pytest -q',
    explore: ['Trace the import path end to end', 'Find every frontmatter reader'],
    plan: 'Plan the folder importer',
    debug: 'Reproduce the BOM import failure',
  },
  'pixel-garden': {
    ask: 'Let plants keep growing while the tab is closed',
    fix: 'Plants regrow from seed after a reload',
    files: ['src/growth.ts', 'src/save.ts', 'src/garden.ts'],
    grep: 'elapsedSince(',
    test: 'npm test',
    explore: ['Map how growth ticks are scheduled', 'Find what the save file stores'],
    plan: 'Plan wall-clock growth',
    debug: 'Reproduce the regrow-on-reload bug',
  },
};

const GENERIC = {
  ask: 'Tidy up the module layout',
  fix: 'The test suite fails on a clean checkout',
  files: ['src/index.js', 'src/util.js', 'README.md'],
  grep: 'export function',
  test: 'npm test',
  explore: ['Map the module graph', 'Find the entry points'],
  plan: 'Plan the refactor',
  debug: 'Reproduce the failing test',
};

// Scripts: [second, kind, ...args]. Kinds: start, prompt(text), tool(name,
// input), error(name, input), spawn(type, description, background),
// return (the blocking spawn's own PostToolUse), substop, stop, end.
// Role A delegates: two backgrounded Explore agents, then a Plan agent, each
// closed by a SubagentStop (as many stops as spawns, so each closes one).
function delegating(f) {
  return [
    [0, 'start'], [1, 'prompt', f.ask],
    [3, 'tool', 'Read', { file_path: f.files[0] }],
    [5, 'tool', 'Grep', { pattern: f.grep }],
    [7, 'spawn', 'Explore', f.explore[0], true],
    [8, 'spawn', 'Explore', f.explore[1], true],
    // a subagent's tool calls surface under its parent's session id
    [12, 'tool', 'Read', { file_path: f.files[1] }],
    [16, 'tool', 'Grep', { pattern: f.grep }],
    [21, 'tool', 'Read', { file_path: f.files[2] }],
    [26, 'tool', 'Glob', { pattern: '**/*' }],
    [31, 'tool', 'Read', { file_path: f.files[0] }],
    [36, 'tool', 'Grep', { pattern: 'TODO' }],
    [41, 'spawn', 'Plan', f.plan, true],
    [46, 'tool', 'Read', { file_path: f.files[1] }],
    [52, 'tool', 'Read', { file_path: f.files[2] }],
    [58, 'substop'],
    [63, 'tool', 'Edit', { file_path: f.files[2] }],
    [68, 'tool', 'Edit', { file_path: f.files[1] }],
    [72, 'substop'],
    [77, 'tool', 'Bash', { command: f.test }],
    [82, 'tool', 'Edit', { file_path: f.files[1] }],
    [86, 'substop'],
    [90, 'tool', 'Bash', { command: f.test }],
    [94, 'stop'], [98, 'end'],
  ];
}

// Role B fixes a bug: a failing test, one blocking general-purpose agent that
// closes exactly on its own PostToolUse, then edits until green. No SessionEnd
// - the card idles into the next loop and ages out like a real one.
function fixing(f) {
  return [
    [24, 'start'], [25, 'prompt', f.fix],
    [28, 'tool', 'Read', { file_path: f.files[1] }],
    [32, 'tool', 'Grep', { pattern: f.grep }],
    [36, 'error', 'Bash', { command: f.test }],
    [47, 'spawn', 'general-purpose', f.debug, false],
    [52, 'tool', 'Read', { file_path: f.files[0] }],
    [56, 'tool', 'Grep', { pattern: f.grep }],
    [61, 'tool', 'Read', { file_path: f.files[1] }],
    [66, 'tool', 'Bash', { command: f.test }],
    [70, 'tool', 'Read', { file_path: f.files[2] }],
    [76, 'return'],
    [80, 'tool', 'Edit', { file_path: f.files[1] }],
    [88, 'tool', 'Bash', { command: f.test }],
    [95, 'tool', 'Edit', { file_path: f.files[0] }],
    [100, 'tool', 'Bash', { command: f.test }],
    [104, 'stop'],
  ];
}

// Role V triages the vault itself - the session resolves to README, the
// node at the centre of the rings
const vault = () => [
  [50, 'start'], [51, 'prompt', '/triage'],
  [54, 'tool', 'Read', { file_path: 'inbox.md' }],
  [59, 'tool', 'Grep', { pattern: '^description:' }],
  [64, 'tool', 'Read', { file_path: 'CONVENTIONS.md' }],
  [70, 'tool', 'Read', { file_path: 'lessons/fs-watch-fires-twice-per-save.md' }],
  [76, 'tool', 'Write', { file_path: 'lessons/debounce-beats-dedupe.md' }],
  [83, 'tool', 'Edit', { file_path: 'README.md' }],
  [89, 'tool', 'Edit', { file_path: 'inbox.md' }],
  [96, 'tool', 'Bash', { command: 'git commit -m "Triage the inbox"' }],
  [104, 'stop'], [110, 'end'],
];

// script -> raw generic-shape events (what POST /api/hook-event?source=demo
// would accept). `at(sec)` maps script seconds to a timestamp.
function render(script, { sessionId, cwd, at }) {
  const out = [];
  const base = { sessionId, cwd };
  const ev = (sec, event, extra = {}) => out.push({ ts: Math.round(at(sec)), event, ...base, ...extra });
  for (const [sec, kind, a, b, c] of script) {
    switch (kind) {
      case 'start': ev(sec, 'SessionStart'); break;
      case 'prompt': ev(sec, 'UserPromptSubmit', { prompt: a }); break;
      case 'tool':
        ev(sec, 'PreToolUse', { tool: a, input: b });
        ev(sec + 0.8, 'PostToolUse', { tool: a });
        break;
      case 'error':
        ev(sec, 'PreToolUse', { tool: a, input: b });
        ev(sec + 2, 'PostToolUse', { tool: a, isError: true });
        break;
      case 'spawn':
        ev(sec, 'PreToolUse', { tool: 'Agent', input: { subagent_type: a, description: b, run_in_background: c } });
        // a backgrounded call hands its handle straight back; a blocking one
        // returns only when the subagent is done - see 'return'
        if (c) ev(sec + 0.3, 'PostToolUse', { tool: 'Agent' });
        break;
      case 'return': ev(sec, 'PostToolUse', { tool: 'Agent' }); break;
      case 'substop': ev(sec, 'SubagentStop'); break;
      case 'stop': ev(sec, 'Stop'); break;
      case 'end': ev(sec, 'SessionEnd'); break;
      default: break;
    }
  }
  return out;
}

// short, stable, hex-ish: the Agents board shows the first 8 characters of a
// session id the way it shows a real UUID prefix
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const sid = (...parts) => `demo${(hash(parts.join('|')) & 0xffff).toString(16).padStart(4, '0')}-${parts.join('-')}`;

// mulberry32: a seeded PRNG so history varies by day yet repeats exactly
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flavour = (id) => FLAVOUR[id] ?? GENERIC;
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

// demo:false never runs it; otherwise only on the bundled starter vault before
// any hook event exists - a real vault or a machine with history never sees it
export function shouldRunDemo({ demo, vaultPath, root, hasEvents }) {
  if (demo === false || hasEvents) return false;
  // relative() compares case-insensitively on win32, as the filesystem does
  return path.relative(path.resolve(vaultPath), path.join(root, 'starter-vault')) === '';
}

// what the script needs from the graph: project id -> literal dir, the vault dir
export function anchorsFromGraph(graph) {
  const projects = {};
  for (const n of graph?.nodes ?? []) {
    if (n.type === 'project' && n.dir) projects[n.id] = n.dir;
  }
  return { projects, vaultDir: graph?.vaultPath ?? null };
}

// the starter projects in script order, then any others; [] when none
function projectIds(anchors) {
  const ids = Object.keys(anchors?.projects ?? {});
  return [...ORDER.filter((id) => ids.includes(id)), ...ids.filter((id) => !ORDER.includes(id)).sort()];
}

/**
 * One loop of live sessions, raw and unsanitized - their stamps lie in the
 * future when generated, so they go through tracker.record() only as each one
 * comes due. Projects rotate through roles A and B loop by loop.
 */
export function demoLoop({ startTs, loopIndex = 0, anchors, loopMs = LOOP_MS }) {
  const ids = projectIds(anchors);
  const at = (sec) => startTs + Math.min(sec * 1000, loopMs - 1);
  const out = [];
  if (ids.length) {
    const a = ids[loopIndex % ids.length];
    const b = ids[(loopIndex + 1) % ids.length];
    out.push(...render(delegating(flavour(a)), { sessionId: sid('live', a, loopIndex), cwd: anchors.projects[a], at }));
    if (b !== a) out.push(...render(fixing(flavour(b)), { sessionId: sid('live', b, loopIndex), cwd: anchors.projects[b], at }));
  }
  if (anchors?.vaultDir) {
    out.push(...render(vault(), { sessionId: sid('live', 'vault', loopIndex), cwd: anchors.vaultDir, at }));
  }
  return out.sort((x, y) => x.ts - y.ts);
}

/**
 * The `days` days before today (UTC), one or two sessions each, already
 * sanitized into the log's shape. Depends only on the UTC day of `now`, so
 * Flows and Stats see the same history all day long.
 */
export function demoHistory({ now = Date.now(), anchors, days = HISTORY_DAYS }) {
  const ids = projectIds(anchors);
  const today = Date.parse(`${dayOf(now)}T00:00:00Z`);
  const out = [];
  for (let d = days; d >= 1; d--) {
    const dayStart = today - d * DAY_MS;
    const date = dayOf(dayStart);
    const rand = rng(hash(date));
    const count = 1 + Math.floor(rand() * 2);
    for (let k = 0; k < count; k++) {
      const useVault = k === 1 && rand() < 0.4 && anchors?.vaultDir;
      if (!useVault && !ids.length) continue;
      const id = useVault ? 'vault' : ids[(d + k) % ids.length];
      const script = useVault ? vault() : (k === 0 ? delegating : fixing)(flavour(id));
      // stretch the 2-minute script into a 10-25 minute session; half of them
      // break for coffee mid-way, which Flows draws as a compressed gap
      const scale = 5 + Math.floor(rand() * 8);
      const breakAt = rand() < 0.5 ? 60 : Infinity;
      const breakMs = (4 + Math.floor(rand() * 5)) * 60_000;
      const startMs = dayStart + (8 + k * 5 + Math.floor(rand() * 3)) * 3_600_000 + Math.floor(rand() * 50) * 60_000;
      const at = (sec) => startMs + sec * 1000 * scale + (sec > breakAt ? breakMs : 0);
      const cwd = useVault ? anchors.vaultDir : anchors.projects[id];
      const raw = render(script, { sessionId: sid(date.replaceAll('-', ''), id, k), cwd, at });
      for (const e of raw) out.push(...sanitizeEvents(e, { source: DEMO_SOURCE, now: () => e.ts }));
    }
  }
  return out.sort((x, y) => x.ts - y.ts);
}
