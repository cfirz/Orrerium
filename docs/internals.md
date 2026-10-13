# Orrerium internals

How the pieces fit, and why the agent read-out works the way it does. The
[README](../README.md) covers using Orrerium; this is for changing it.

## Architecture

- `server.js` — plain `node:http`: every request passes the request guard, then static files (`Cache-Control: no-cache` — live edits, no stale modules), JSON routes, one SSE route. A request that throws answers 500 instead of taking the process down.
- `lib/request-guard.js` — pure Host/Origin check run before routing: a loopback listener answers only its own host names (no DNS rebinding), and writes refuse a foreign `Origin` or `Sec-Fetch-Site` (no cross-site POSTs). Non-browser clients send neither header. See [SECURITY.md](../SECURITY.md).
- `lib/sse.js` — the SSE channel: named events (`broadcast(event, payload)`), one client set, keepalive pings. `public/js/bus.js` is its client twin: one shared `EventSource`, panels subscribe by event name.
- `lib/store.js` — Orrerium-owned writable state under `data/` (gitignored): atomic JSON writes (tmp+rename) and NDJSON append logs. The vault stays read-only.
- `lib/agents.js` — hook events in, board state out: one adapter per wire dialect, sanitizing, the session state machine, NDJSON persistence. See [The agent event pipeline](#the-agent-event-pipeline).
- `lib/event-log.js` — the read side of that log for Flows and Stats: the last 14 calendar days, each day file parsed once and memoized on `(mtime, size)`, plus retention (`eventRetentionDays`).
- `lib/flows.js` / `lib/stats.js` — pure: events → a replayable timeline per session / per-day rollups.
- `lib/demo.js` + `lib/demo-feeder.js` — the first-launch demo replay. See [Demo replay](#demo-replay).
- `lib/claude-scan.js` — cross-repo scanner: `.claude/{skills,agents,commands}` across `claudeScan.roots` + the global dir become **agent**/**command**/**routine** nodes (namespaced ids like `DemoApp.qa-agent`, short `label` for display), merged onto the graph with one `scan` edge to the repo's vault project note (matched on `dir` frontmatter) or a synthetic **repo** anchor.
- `lib/vault.js` — pure parser: frontmatter (vault dialect) + wikilink (`[[slug]]`, `[[slug|alias]]`, `[[slug#heading]]`) and md-link extraction, plus `.claude/skills/*/SKILL.md` as **routine** nodes. Importable by agents and CLIs; no http/fs.watch in it.
- `lib/graph.js` — pure: notes → `{nodes, edges, warnings}`; undirected dedupe, ghost nodes for unresolved wikilinks, degree; **application** nodes derived from `applicationTags` with tag edges to every note carrying the tag; routine edges from real markdown links and `x.md` mentions in skill bodies.
- `lib/watch.js` — debounced recursive `fs.watch`; every change triggers a full re-parse (the vault is small; incremental bookkeeping is not worth bugs). A rebuild that throws keeps the last good graph.
- `public/js/graph-view.js` — SVG graph with two layouts: **Rings** (default — concentric orbits with README at the core, then root docs, PROJECTS, LESSONS, MACHINE, IDEAS, TEMPLATES, ROUTINES, and hexagonal APPLICATIONS outermost; notes are angularly sorted toward the projects they link to) and **Force** (Obsidian-style d3-force; position cache keeps live reloads from re-exploding the layout). Hovering a node lights its links and fades the rest; clicking it pins that highlight until a click elsewhere, with hover still previewing other nodes meanwhile.
- `public/js/agent-activity.js` — live agent traffic on the graph, in both layouts (see [Live agent activity](#live-agent-activity)). Pure derivation: the agents SSE snapshot reduces to live nodes, live edges and a per-node count of subagents in flight, which `graph-view.js` paints.
- `public/js/md.js` + `md-safe.js` — marked with a wikilink tokenizer; every in-vault link navigates the graph. `md-safe.js` holds the import-free, tested safety rules: raw HTML renders as text, and only http(s), `mailto:`, `#` and relative `.md` links stay links.
- `public/js/panels.js` + the `*-panel.js` modules — the dashboard shell: a topbar nav switches panels; the projects board renders from graph-node frontmatter (`status`, `dir`, tags, degree) and clicks through to the graph; the inbox view counts entries with `inbox-count.js` (import-free, tested) and flags the triage threshold.
- `public/js/search.js` — substring filter over id/description/tags.
- `public/vendor/` — committed single-file builds of d3 and marked ([versions and licenses](../public/vendor/README.md)).
- The vault's `.obsidian/graph.json` was the design reference for colours/forces; it is **never read or written at runtime** (Obsidian clobbers it).
- `window.orrerium` in the browser console exposes the view, graph data and simulation for debugging.

## The agent event pipeline

Events reach the server by POSTing to `/api/hook-event` through
[hooks/emit.js](../hooks/emit.js) — a fire-and-forget relay that always exits 0
and swallows every failure, so sessions never notice when Orrerium is down (a
Claude Code PreToolUse hook that exits non-zero would block the tool call).

Events are translated per source, whitelisted and truncated server-side
(`lib/agents.js` — one adapter per wire dialect, everything downstream speaks
the canonical shape), appended to `data/agent-events/YYYY-MM-DD.ndjson`, and
replayed on server start so a restart never blanks the board (pre-0.3 log lines
without a `source` replay as `claude-code`). Foreign session ids are normalized
to URL-safe form at ingest, and a `ts` that is invalid or more than a minute in
the future becomes the arrival time — it names the day file, so a bogus one
would otherwise squat in every "recent" window. Sessions silent for 24 hours drop
out of the live board (they stay in the logs); day logs older than
`eventRetentionDays` are pruned at startup and daily.

Subagent spawns are detected as `PreToolUse` of the `Agent` tool (older Claude
Code builds called it `Task`, and log days from back then still hold those
events, so both names count — `isSubagentTool` in `lib/agents.js`). Completion
is per-kind. A **blocking** `Agent` call closes on its own `PostToolUse` — the
call does not return until the subagent is done, and only one can block at a
time, so the match is exact. A **backgrounded** call (`run_in_background` absent
or true — Pre and Post land in the same second while the subagent runs on) has
no dependable completion at all: `SubagentStop` fires at **turn end whether a
subagent ran or not** (measured over a day of one machine's logs: 11 stops, 9 of
them 3–23s after a `Stop` in sessions that spawned nothing), and its payload
carries no subagent identity to match on. So stops are **counted, not matched**:
one past the cumulative spawn count is known-unattributable and closes nothing.
The cost is the mirror case — a turn-end stop inflates the counter and can make a
later genuine stop look unattributable, leaving that subagent `working` — so
every spawn also carries a lease (`inFlightSubagents`, 15 minutes), past which it
stops counting as in flight. Erring long is deliberate for a live read-out; a
proper fix needs an id on the event.

### Session kinds

The Claude desktop app emits hook events of its own, so every session in the
snapshot carries a `kind` (`classifySession` in `lib/agents.js`): `work` for
real sessions, `startup` for the throwaway sessions the app opens and closes on
launch (Start+End pair, no prompt, no tools — one per recent project plus one
rooted at the home dir), and `housekeeping` for the bare-`SessionEnd` bursts its
periodic tick emits while finalizing old sessions (~every 2h at :28 past the
hour while the app is open). Those two heuristics apply only to `claude-code`
sessions — another tool's promptless ended session stays `work`. The board's
filter chips (All · Live · Idle · Ended · System) keep the two system kinds out
of every view except System, which shows them labeled for what they are.

### Sessions with subagents in flight

A subagent's tool calls normally surface under the parent session id (verified:
two parallel `Explore` agents logged interleaved, duplicate reads of the same
file in the same second), so a delegating session is usually the opposite of
quiet — but a blocking `Agent` call whose subagent sits inside one long tool call
really does fall silent, and an unreliable `SubagentStop` can leave `working`
entries behind. So a session with subagents out holds the 15-minute lease
instead of the 90s window (`DEFAULT_SUBAGENT_STALE_MS` server-side,
`SUBAGENT_WARM_MS` on the client, mirrored the way `WARM_MS` mirrors
`DEFAULT_STALE_MS`), the snapshot carries a `waiting` count so the board reads
"Waiting on 2 subagents" rather than "idle — turn ended", and the client ignores
the server's `stale` flag for exactly those sessions. The lease is what keeps a
lost completion from lighting a node forever.

### What the hook stream cannot see

Agents launched through the Claude Agent SDK. An SDK `query()` spawns its own
`claude` subprocess with `settingSources` empty by default, so
`~/.claude/settings.json` — and the hooks installed there — never load. Those
runs either surface as separate sessions (if the app passes hooks itself) or not
at all; the generic-ingest endpoint (`POST /api/hook-event?source=<slug>`) is the
way to wire such an orchestrator in.

## Flows

`#/flows` replays the same log as a timeline: subagent spans stack above the
orchestrator lane (parallel agents get parallel lanes, packed greedily by
`lib/flows.js`), tool ticks and prompt diamonds ride lane 0, idle gaps over two
minutes collapse to a fixed-width break, and a scrubber replays the run
(`setInterval`-driven — rAF pauses in hidden panes). Live sessions redraw as
events arrive.

## Live agent activity

The agents snapshot is painted onto the graph itself, in both layouts. A live
session resolves to its project node by matching `cwd` against node `dir`
(walking up parent directories, and filtered to project/repo nodes — agent and
command nodes carry their repo's `dir` too, so an unfiltered index resolves a
session to a random command). A session working in the vault itself resolves to
`README`, the node at the centre of the rings. Each of its **working** subagents
resolves to that repo's agent node — same repo first, then a global agent, then
nothing, because lighting another repo's `qa-agent` would be a lie. The existing
`scan` edge between them then carries star dots from the project out to the
agent, a ring of sparks orbits every live node, and one ripple fires per spawn or
burst of tool calls. Whichever node a dot is travelling to flashes once as each
dot reaches its rim.

A session with no working subagent that resolves to a node of its own — the
common case, whether nothing was spawned or what was spawned is a built-in type —
has no agent edge to carry traffic, so it radiates along its own strongest links
instead (frontmatter before body before tag, capped at four per node and picked
deterministically, or the d3 join churns and restarts every animation). Those
ambient sparks are thinner, dimmer and slower so attributable agent traffic still
reads as the stronger signal, they travel *away* from the live node whichever end
of the edge it sits on, and they deliberately do not mark the far end live: those
neighbours are context, not running work (their arrival flash is softer, too).
Sessions decay hot → warm → dark on the client (20s / 90s, the second matching
the server's stale threshold), because a quiet session produces no new snapshot
to react to.

Subagents whose **type has no node** — the built-ins (`general-purpose`,
`Explore`, `Plan`, …) have no `.claude/agents/*.md` file behind them, so
`resolveAgentNode` finds nothing — are counted on the orchestrator's anchor, and
their spawn ripples that node. `deriveActivity` returns a third map for this,
`subagents`: node id → agents in flight there, its own type's node where one
exists, else the anchor. The view paints it as a second, wider, counter-rotating
ring of one dot per agent, so *how many agents are working* reads separately
from *how recently the session spoke*. Counts feed the signature guard too, or a
spawn landing on an already-lit node would be swallowed as "no change".

### Animation mechanics

All of that motion is **CSS keyframes, not a JS loop** — rAF pauses in hidden
panes, so a per-frame animation would silently freeze. Travelling dots are a
near-zero dash on a copy of the edge with `pathLength="100"`, so one
`stroke-dashoffset` keyframe fits every edge length; the orbit rotates about the
node's local origin via `transform-box: view-box; transform-origin: 0 0`. The
arrival flash is the one exception, because a stylesheet cannot know when a dot
lands: it is a Web Animation whose `startTime` is pinned to the spark's own CSS
animation on the document timeline, so both run on the same clock with no
per-dot events or timers. A `display: none` (switching panels) restarts the
spark's clock, so each spark's `animationstart` re-pins its flash. Under
`prefers-reduced-motion: reduce` the decorative traffic can withdraw entirely,
with live nodes still reading as live through their static styling — but that
branch is opt-in: motion defaults to **On** and only an explicit Auto on the
graph's **motion** toggle hands the decision back to the OS. (Windows: switching
the OS "animation effects" off makes Chrome report `reduce` for every page,
which is exactly why the sparks — the live-activity read-out itself — do not
disappear by default.)

## Icons

`#/icons` assigns hand-authored pixel faces
([public/js/icons.js](../public/js/icons.js), 12×12 grids as data — no asset
pipeline) to scanned agents. Assignments live in `data/icon-assignments.json`
(`GET /api/icons`, `POST /api/icons/assign`) and every consumer — board rows,
graph agent nodes — repaints over the `icons` SSE event.

## Demo replay

On the bundled starter vault, before any hook event has ever been logged
(`shouldRunDemo` in `lib/demo.js`), the server plays a scripted two-minute loop
of sessions over the starter projects: one delegating to backgrounded `Explore`
and `Plan` agents, one fixing a bug through a blocking `general-purpose` agent,
one triaging the vault's inbox. Projects rotate through the roles loop by loop,
and a week of seeded history (one or two longer sessions a day, some with a
coffee break Flows compresses) backs the Flows and Stats panels.

- `lib/demo.js` is pure and deterministic: script tables in, generic-shape events
  out, no timers and no `Math.random` (history is seeded per UTC day).
- Session cwds are the starter projects' literal `dir` strings (`~/code/…`): the
  client matches cwd to `dir` by lowercased path prefix with no `~` expansion.
  The starter vault has no agent files, so every demo subagent is a built-in type
  riding its project's subagent ring.
- `lib/demo-feeder.js` plays the loop into its own `createAgentTracker({ dataDir:
  null })` — no data dir, so nothing reaches `data/`. Its clock and timers are
  injected, so the tests drive it without waiting. The first loop starts a minute
  in the past, so a fresh page load is already lit; a machine that slept through
  several loops restarts from now rather than replaying the backlog.
- While it runs, `/api/agents`, `/api/flows*` and `/api/stats` serve the feeder's
  data with `demo: true`, and the UI shows a `demo` badge and banner. The first
  real `POST /api/hook-event` stops the feeder and records into the real tracker;
  that event also creates the log, so the next start does not demo either.

## Wiring Claude Code by hand

`node hooks/install.js --print` generates this for every tool. For Claude Code,
add hook entries for **all seven** events — `SessionStart`, `UserPromptSubmit`,
`PreToolUse` (matcher `*`), `PostToolUse` (matcher `*`), `SubagentStop`, `Stop`,
`SessionEnd` — each running the same command (replace the path with your clone's
absolute path):

```json
"hooks": {
  "SessionStart": [{ "hooks": [
    { "type": "command", "command": "node \"/path/to/Orrerium/hooks/emit.js\"", "timeout": 5 }
  ]}],
  "UserPromptSubmit": [{ "hooks": [
    { "type": "command", "command": "node \"/path/to/Orrerium/hooks/emit.js\"", "timeout": 5 }
  ]}],
  "PreToolUse": [{ "matcher": "*", "hooks": [
    { "type": "command", "command": "node \"/path/to/Orrerium/hooks/emit.js\"", "timeout": 5 }
  ]}],
  "PostToolUse": [{ "matcher": "*", "hooks": [
    { "type": "command", "command": "node \"/path/to/Orrerium/hooks/emit.js\"", "timeout": 5 }
  ]}],
  "SubagentStop": [{ "hooks": [
    { "type": "command", "command": "node \"/path/to/Orrerium/hooks/emit.js\"", "timeout": 5 }
  ]}],
  "Stop": [{ "hooks": [
    { "type": "command", "command": "node \"/path/to/Orrerium/hooks/emit.js\"", "timeout": 5 }
  ]}],
  "SessionEnd": [{ "hooks": [
    { "type": "command", "command": "node \"/path/to/Orrerium/hooks/emit.js\"", "timeout": 5 }
  ]}]
}
```

If Orrerium listens on a non-default port, set `ORRERIUM_PORT` in the environment
the hooks run in.
