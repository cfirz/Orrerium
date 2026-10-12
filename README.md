# Orrerium

[![CI](https://github.com/cfirz/Orrerium/actions/workflows/ci.yml/badge.svg)](https://github.com/cfirz/Orrerium/actions/workflows/ci.yml)

Local-first dashboard over a markdown knowledge vault: no build step, zero npm
dependencies, all state in files that both humans and AI agents can read.

Three core panels: **Brain** (interactive graph of the vault with note reader,
search, and live reload), **Projects** (a board built from
project-page frontmatter), and **Inbox** (the capture buffer with a
ready-for-triage indicator, and a waiting-capture count on its topbar tab). Panels deep-link via the URL hash (`#/brain`,
`#/projects`, `#/inbox`).

If you use [Claude Code](https://claude.com/claude-code), the graph can also map
your whole machine's agent setup: `.claude/{skills,agents,commands}` across every
repo under the configured roots plus the global `~/.claude` land on an **AGENTS**
orbit, and live sessions light up the graph in real time (see
[Agents board](#agents-board)). None of that is required — the vault dashboard
works on its own.

![The Brain graph over an example vault: notes on the inner rings, the machine's skills, agents and commands on the outer ones, and two projects lit up cyan, sending dots out to the agent nodes of their working subagents, each of which flashes as a dot arrives](docs/screenshot.gif)

*Above, animated and live: an example vault — 23 lessons, 9 project pages,
7 machine notes — plus a scanned Claude Code setup across eight repos. Two
projects are delegating, six subagents on a WebGL game repo and four on a kids'
game, while a third session quietly triages the vault's own inbox. Dots travel
from each project out to the agents doing its work, and a node flashes as each
dot reaches it. The tight cyan ring marks a node that is live right now; the
wider, counter-rotating one carries a dot per subagent working there.*

## Quick start

```
git clone https://github.com/cfirz/Orrerium
cd Orrerium
node server.js
```

Then open http://127.0.0.1:4321. Requires Node 20+ (uses `fs.watch` recursive
and `node:test`). There is nothing to install — with no configuration, Orrerium
boots against the bundled demo vault in [starter-vault/](starter-vault/).

Prefer a double-click? [orrerium.bat](orrerium.bat) (Windows) and
[orrerium.sh](orrerium.sh) (macOS/Linux) start the server, open the browser once
it answers, and reuse an already-running instance instead of starting a second
one. The server runs in that window — Ctrl+C or closing it stops the server.

## First-time setup

Three steps, all offline — no accounts, no API keys, nothing to install.

**1. Install Node.js** — version 20 or newer, from
[nodejs.org](https://nodejs.org). To check what you have:

```
node -v      # should print v20.x or higher
```

**2. Download Orrerium** — on the
[GitHub page](https://github.com/cfirz/Orrerium), click **Code → Download ZIP**
and unzip it anywhere. Or, if you use git:

```
git clone https://github.com/cfirz/Orrerium
```

**3. Open it** — double-click [orrerium.bat](orrerium.bat) (Windows) or run
[orrerium.sh](orrerium.sh) (macOS/Linux):

```
cd Orrerium
./orrerium.sh     # macOS / Linux — Windows: double-click orrerium.bat
```

Your browser opens on a small demo vault — click any node to read its note.

That's it. Whenever you're ready:

- **Use your own notes** — see
  [Point it at your own vault](#point-it-at-your-own-vault).
- **Live agent tracking** (optional, Claude Code users) — see
  [Agents board](#agents-board).

### Troubleshooting

- **`vaultPath is not a directory`** — the vault path you set doesn't exist
  (or `config.json` points somewhere stale). Remember `~` is not expanded in
  `config.json`.
- **`Port 4321 is already in use`** — another Orrerium (or something else) owns
  the port. Stop it, or set `port` in `config.json`. If hooks should reach a
  non-default port, also set `ORRERIUM_PORT` where the hooks run.
- **Errors on startup** — almost always Node older than 20; check `node -v`.
- **Agents / Flows / Icons panels are empty** — expected until the
  [Agents board](#agents-board) hooks are installed (`node hooks/install.js`,
  optionally `--tool gemini` / `--tool codex`) and an agent session runs.
- **Graph is static (no spark animations)** — your OS has reduced motion
  switched on *and* the graph's **motion** toggle is set to Auto; switch it back
  to **On** (the default). On Windows, turning "animation effects" on in
  Settings also brings the motion back.

## Point it at your own vault

Any folder of markdown files works, and Orrerium treats it as **strictly
read-only** — it never touches your notes. Either set `ORRERIUM_VAULT` when
starting the server:

```
ORRERIUM_VAULT=/path/to/your/vault node server.js     # macOS / Linux
```

```
set ORRERIUM_VAULT=C:\path\to\your\vault && node server.js    # Windows cmd
$env:ORRERIUM_VAULT="C:\path\to\your\vault"; node server.js   # PowerShell
```

or, for a permanent setting, copy
[config.example.json](config.example.json) to `config.json` (gitignored) and
set `vaultPath`. Use absolute paths in `config.json` — `~` is not expanded.

You get the most out of the dashboard when the vault follows the conventions the
UI understands (the bundled [starter-vault/](starter-vault/) demonstrates all of
them, and its [CONVENTIONS.md](starter-vault/CONVENTIONS.md) explains the why):

- **Type folders** — notes live in `projects/`, `lessons/`, `machine/`, `ideas/`,
  `templates/`; the folder gives the node its type, colour, and ring. Notes in
  other folders still render, just untyped. A vault with different folder names
  (PARA, Zettelkasten, …) can map them onto the same five types via
  `folderTypes` in `config.json`.
- **A root `README.md`** — sits at the centre of the Rings layout as the vault's
  index.
- **Frontmatter** — `name`, one-line quoted `description`, `type`, `updated`;
  project pages carry `status` and `dir` (the projects board is built from
  these); `projects: ["[[slug]]"]` wikilinks cluster the graph.
- **An `inbox.md` capture buffer** — feeds the Inbox panel, with `capture` and
  `triage` skills under `.claude/skills/` (rendered as ROUTINE nodes).

To adopt the whole system, copy `starter-vault/` somewhere, delete the sample
notes, and start capturing.

### Configuration reference

| Key | Default | Meaning |
|---|---|---|
| `vaultPath` | `starter-vault` | Markdown vault to visualize (relative paths resolve from the repo root; `ORRERIUM_VAULT` overrides) |
| `host` / `port` | `127.0.0.1` / `4321` | Where the dashboard listens — keep it on loopback, see [SECURITY.md](SECURITY.md) |
| `excludeDirs` | `.obsidian`, `.claude`, `.git` | Folders never scanned (skills are scanned explicitly) |
| `applicationTags` | `unity`, `python`, … | Tags that become APPLICATION nodes on the outer ring |
| `folderTypes` | `projects` → `project`, … | Folder name → note type for vaults with different conventions; values must be one of the five built-in types, and a provided map **replaces** the default (start from a copy of it) |
| `claudeScan.roots` | `[]` | Dirs whose children are scanned (one level) for `.claude/{skills,agents,commands}` — absolute paths, e.g. `["C:/code"]` or `["/Users/you/code"]` |
| `claudeScan.globalDir` | `~/.claude` | The global Claude dir, scanned the same way |
| `claudeScan.settingsPath` | `~/.claude/settings.json` | Read for `skillOverrides` so disabled skills render dormant |
| `claudeScan.rescanMs` | `300000` | External repos are re-scanned on this cadence (no watchers) |

## Architecture (10 lines)

- `server.js` — plain `node:http`: static files (`Cache-Control: no-cache` — live edits, no stale modules), JSON routes, one SSE route.
- `lib/sse.js` — the SSE channel: named events (`broadcast(event, payload)`), one client set, keepalive pings. `public/js/bus.js` is its client twin: one shared `EventSource`, panels subscribe by event name.
- `lib/store.js` — Orrerium-owned writable state under `data/` (gitignored): atomic JSON writes (tmp+rename) and NDJSON append logs. The vault stays read-only.
- `lib/claude-scan.js` — cross-repo scanner: `.claude/{skills,agents,commands}` across `claudeScan.roots` + the global dir become **agent**/**command**/**routine** nodes (namespaced ids like `DemoApp.qa-agent`, short `label` for display), merged onto the graph with one `scan` edge to the repo's vault project note (matched on `dir` frontmatter) or a synthetic **repo** anchor.
- `lib/vault.js` — pure parser: frontmatter (vault dialect) + wikilink/md-link extraction, plus `.claude/skills/*/SKILL.md` as **routine** nodes. Importable by agents and CLIs; no http/fs.watch in it.
- `lib/graph.js` — pure: notes → `{nodes, edges, warnings}`; undirected dedupe, ghost nodes for unresolved wikilinks, degree; **application** nodes derived from `applicationTags` with tag edges to every note carrying the tag; routine edges from real markdown links and `x.md` mentions in skill bodies.
- `lib/watch.js` — debounced recursive `fs.watch`; every change triggers a full re-parse (the vault is small; incremental bookkeeping is not worth bugs).
- `public/js/graph-view.js` — SVG graph with two layouts: **Rings** (default — concentric orbits with README at the core, then root docs, PROJECTS, LESSONS, MACHINE, IDEAS, TEMPLATES, ROUTINES, and hexagonal APPLICATIONS outermost; notes are angularly sorted toward the projects they link to) and **Force** (Obsidian-style d3-force; position cache keeps live reloads from re-exploding the layout). Hovering a node lights its links and fades the rest; clicking it pins that highlight until a click elsewhere, with hover still previewing other nodes meanwhile.
- `public/js/agent-activity.js` — live agent traffic on the graph, in both layouts (see "Live agent activity"). Pure derivation: the agents SSE snapshot reduces to live nodes, live edges and a per-node count of subagents in flight, which `graph-view.js` paints.
- `public/js/note-panel.js` — marked with a wikilink tokenizer; every in-vault link navigates the graph.
- `public/js/search.js` — substring filter over id/description/tags.
- `public/vendor/` — committed single-file builds of d3 and marked ([versions and licenses](public/vendor/README.md)).
- The vault's `.obsidian/graph.json` was the design reference for colours/forces; it is **never read or written at runtime** (Obsidian clobbers it).
- `public/js/panels.js` + `projects-panel.js` + `inbox-panel.js` — the dashboard shell: a topbar nav switches panels; the projects board renders from graph-node frontmatter (`status`, `dir`, tags, degree) and clicks through to the graph; the inbox view renders `inbox.md` captures and flags the triage threshold.
- `window.orrerium` in the browser console exposes the view, graph data and simulation for debugging.

## Agents board

*This whole section is entirely optional — without a hook setup below, the
Agents, Flows and Icons panels are simply empty.*

`#/agents` shows agent sessions on the machine live: the orchestrator's current
activity, spawned subagents and their status, tool and error counts. Claude Code
gets the full picture; Gemini CLI and Codex CLI can report too (with the
fidelity their hook systems allow), and anything else can feed the board through
a small generic event shape. Every event carries a `source`, each card wears a
source badge, and a source filter row appears once a second tool reports.

Events reach the board by POSTing to `/api/hook-event` through
[hooks/emit.js](hooks/emit.js) — a fire-and-forget relay that always exits 0 and
swallows every failure, so sessions never notice when Orrerium is down (a
Claude Code PreToolUse hook that exits non-zero would block the tool call).

To enable, run the installer once from your clone, per tool:

```
node hooks/install.js
```

```
node hooks/install.js --tool gemini
```

```
node hooks/install.js --tool codex
```

- **Claude Code** (the default) merges hook entries for all seven events into
  `~/.claude/settings.json` — full live activity: prompts, tools, subagents.
- **Gemini CLI** merges its six hook events (`SessionStart`, `BeforeAgent`,
  `BeforeTool`, `AfterTool`, `AfterAgent`, `SessionEnd`) into
  `~/.gemini/settings.json`, tagged `--source=gemini-cli`; the server maps that
  vocabulary onto the canonical one, so cards show prompts and tool activity.
- **Codex CLI** sets the single top-level `notify` key in `~/.codex/config.toml`.
  Codex only notifies when a turn *completes*, so its cards are honest but
  coarse — one card per turn with the prompt, no live tool activity; that is all
  Codex exposes. The installer refuses to clobber a `notify` you already have
  (Codex supports exactly one) and prints manual instructions instead.

Every install shows the plan and asks before writing, and backs the file up
beside itself first — every other setting and every existing hook stays
untouched. `--dry-run` previews without writing, `--uninstall` takes the hooks
back out, `--print` emits the config snippet for wiring by hand, and re-running
after moving the clone fixes up the stale paths. Already-running sessions pick
the hooks up on their next restart.

**Any other tool** (Grok CLI, CI jobs, your own scripts) can feed the board by
POSTing events in the normalized shape to
`/api/hook-event?source=<its-slug>` (slug: lowercase `[a-z0-9-]`, max 32):

```json
{ "ts": 1755500000000, "event": "PreToolUse", "sessionId": "run-42",
  "cwd": "/repo", "tool": "compile", "prompt": "...", "input": { "command": "..." } }
```

`event` is one of `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `SubagentStop`, `Stop`, `SessionEnd`; everything else is
optional and truncated server-side. `hooks/emit.js --source=<slug>` relays
stdin (or a single JSON argument) there, or POST directly.

Prefer to wire Claude Code by hand? Add hook entries for **all seven** events —
`SessionStart`, `UserPromptSubmit`, `PreToolUse` (matcher `*`), `PostToolUse`
(matcher `*`), `SubagentStop`, `Stop`, `SessionEnd` — each running the same
command (replace the path with your clone's absolute path; `--print` generates
exactly this for every tool):

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

Events are translated per source, whitelisted and truncated server-side
(`lib/agents.js` — one adapter per wire dialect, everything downstream speaks
the canonical shape), appended to `data/agent-events/YYYY-MM-DD.ndjson`, and
replayed on server start so a restart never blanks the board (pre-0.3 log lines
without a `source` replay as `claude-code`). Foreign session ids are normalized
to URL-safe form at ingest. Subagent spawns are detected as `PreToolUse` of
the `Agent` tool (older Claude Code builds called it `Task`, and log days from
back then still hold those events, so both names count — `isSubagentTool` in
`lib/agents.js`). Completion is per-kind. A **blocking** `Agent` call closes on
its own `PostToolUse` — the call does not return until the subagent is done, and
only one can block at a time, so the match is exact. A **backgrounded** call
(`run_in_background` absent or true — Pre and Post land in the same second while
the subagent runs on) has no dependable completion at all: `SubagentStop` fires
at **turn end whether a subagent ran or not** (measured over a day of one
machine's logs: 11 stops, 9 of them 3–23s after a `Stop` in sessions that
spawned nothing), and its payload carries no subagent identity to match on. So
stops are **counted, not matched**: one past the cumulative spawn count is
known-unattributable and closes nothing. The cost is the mirror case — a
turn-end stop inflates the counter and can make a later genuine stop look
unattributable, leaving that subagent `working` — so every spawn also carries a
lease (`inFlightSubagents`, 15 minutes), past which it stops counting as in
flight. Erring long is deliberate for a live read-out; a proper fix needs an id
on the event.

The Claude desktop app emits hook events of its own, so every session in the
snapshot carries a `kind` (`classifySession` in `lib/agents.js`): `work` for
real sessions, `startup` for the throwaway sessions the app opens and closes on
launch (Start+End pair, no prompt, no tools — one per recent project plus one
rooted at the home dir), and `housekeeping` for the bare-`SessionEnd` bursts
its periodic tick emits while finalizing old sessions (~every 2h at :28 past
the hour while the app is open). Those two heuristics apply only to
`claude-code` sessions — another tool's promptless ended session stays `work`.
The board's filter chips (All · Live · Idle · Ended · System) keep the two
system kinds out of every view except System, which shows them labeled for what
they are.

**Flows** (`#/flows`) replays the same log as a timeline: subagent spans stack
above the orchestrator lane (parallel agents get parallel lanes, packed
greedily by `lib/flows.js`), tool ticks and prompt diamonds ride lane 0, and a
scrubber replays the run (`setInterval`-driven — rAF pauses in hidden panes).
Live sessions redraw as events arrive.

**Live agent activity** paints the same snapshot onto the graph itself, in both
layouts. A live session resolves to its project node by matching `cwd` against
node `dir` (walking up parent directories, and filtered to project/repo nodes —
agent and command nodes carry their repo's `dir` too, so an unfiltered index
resolves a session to a random command). Each of its **working** subagents
resolves to that repo's agent node — same repo first, then a global agent, then
nothing, because lighting another repo's `qa-agent` would be a lie. The existing
`scan` edge between them then carries star dots from the project out to the
agent, a ring of sparks orbits every live node, and one ripple fires per spawn
or burst of tool calls. Whichever node a dot is travelling to flashes once as
each dot reaches its rim. A session with no working subagent that resolves to a node of
its own — the common case, whether nothing was spawned or what was spawned is a
built-in type — has no agent edge to carry traffic, so it radiates along its own
strongest links instead (frontmatter before body before tag, capped at four per node and picked
deterministically, or the d3 join churns and restarts every animation). Those
ambient sparks are thinner, dimmer and slower so attributable agent traffic still
reads as the stronger signal, they travel *away* from the live node whichever end
of the edge it sits on, and they deliberately do not mark the far end live: those
neighbours are context, not running work (their arrival flash is softer, too). Sessions decay hot → warm → dark on the
client (20s / 90s, the second matching the server's stale threshold), because a
quiet session produces no new snapshot to react to.

**Sessions with subagents in flight** get their own staleness treatment on both
sides. A subagent's tool calls normally surface under the parent session id
(verified: two parallel `Explore` agents logged interleaved, duplicate reads of
the same file in the same second), so a delegating session is usually the
opposite of quiet — but a blocking `Agent` call whose subagent sits inside one
long tool call really does fall silent, and an unreliable `SubagentStop` can
leave `working` entries behind. So a session with subagents out holds the
15-minute lease instead of the 90s window (`DEFAULT_SUBAGENT_STALE_MS`
server-side, `SUBAGENT_WARM_MS` on the client, mirrored the way `WARM_MS`
mirrors `DEFAULT_STALE_MS`), the snapshot carries a `waiting` count so the board
reads "Waiting on 2 subagents" rather than "idle — turn ended", and the client
ignores the server's `stale` flag for exactly those sessions. The lease is what
keeps a lost completion from lighting a node forever.

Note what the hook stream **cannot** see: agents launched through the Claude
Agent SDK. An SDK `query()` spawns its own `claude` subprocess with
`settingSources` empty by default, so `~/.claude/settings.json` — and the hooks
installed there — never load. Those runs either surface as separate sessions (if
the app passes hooks itself) or not at all; the documented generic-ingest
endpoint (`POST /api/hook-event?source=<slug>`) is the way to wire such an
orchestrator in.

Subagents whose **type has no node** — the built-ins (`general-purpose`,
`Explore`, `Plan`, …) have no `.claude/agents/*.md` file behind them, so
`resolveAgentNode` finds nothing — used to vanish entirely, which is most of why
a delegating session looked empty. They are counted on the orchestrator's anchor
instead, and their spawn ripples that node rather than nothing. `deriveActivity`
returns a third map for this, `subagents`: node id → agents in flight there,
its own type's node where one exists, else the anchor. The view paints it as a
second, wider, counter-rotating ring of one dot per agent, so *how many agents
are working* reads separately from *how recently the session spoke* — which the
single level ring cannot say at all. Counts feed the signature guard too, or a
spawn landing on an already-lit node would be swallowed as "no change".

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
graph's **motion** toggle hands the decision back to the OS. (Windows users:
switching the OS "animation effects" off makes Chrome report `reduce` for every
page, which is exactly why the sparks — the live-activity read-out itself — do
not disappear by default.)

**Icons** (`#/icons`) assigns hand-authored pixel faces
([public/js/icons.js](public/js/icons.js), 12×12 grids as data — no asset
pipeline) to scanned agents. Assignments live in `data/icon-assignments.json`
(`GET /api/icons`, `POST /api/icons/assign`) and every consumer — board rows,
graph agent nodes — repaints over the `icons` SSE event.

## Stats

`#/stats` rolls up everything Orrerium logs into one page: stat tiles for the
last fortnight (sessions, tool calls, errors, subagent
spawns, active time), a per-day bar chart of tool calls with errors overlaid,
and the top tools. Fully offline —
it reads the same `data/` logs the Agents board writes, so it
is empty until those features have something to log.

## API (what an agent can use)

- `GET /api/graph` → `{ generatedAt, vaultPath, nodes, edges, warnings }`
- `GET /api/note/:slug` → `{ id, path, folder, type, frontmatter, markdown }` (also serves scanned claude assets, e.g. `DemoApp.qa-agent`)
- `GET /api/agents` → `{ generatedAt, sessions: [...] }` — the live board snapshot; each session carries its `source`
- `POST /api/hook-event[?source=<slug>]` — agent hook payloads (whitelisted, truncated, logged). No `source` means `claude-code`; `gemini-cli` and `codex` select their dialect adapters; any other slug is read as the normalized generic shape (see [Agents board](#agents-board))
- `GET /api/flows` → `{ sessions: [...] }` — replayable sessions from the last fortnight's log
- `GET /api/stats` → `{ generatedAt, days, totals, topTools }` — per-day usage rollups over the same fortnight (sessions, tool calls, errors, subagent spawns, active time)
- `GET /api/flows/:sessionId` → `{ sessionId, flow: { start, end, lanes, spans, ticks, prompts } }`
- `GET /api/icons` / `POST /api/icons/assign` `{ agent, icon|null }` → `{ assignments }`
- `GET /events` → SSE, named events; `event: vault` with `data: {"files": [...]}` on every vault change (and after a claude-scan delta); `event: agents` with the board snapshot on every hook event

## Test

```
node --test
```

Fixture mini-vault under `test/fixtures/vault/` plus a smoke test against the
bundled starter vault.

## Contributing

Bug reports, fixes, and macOS/Linux portability patches are welcome — please open an
issue before a PR so scope is agreed first. [CONTRIBUTING.md](CONTRIBUTING.md) has the
details, including the three design constraints (zero dependencies, never write the
vault, keep the parser modules pure) that a change must not break.

Security issues go through private reporting rather than a public issue — see
[SECURITY.md](SECURITY.md), which also covers what to keep in mind when running it.

## License

[MIT](LICENSE). Vendored libraries keep their own licenses —
see [public/vendor/README.md](public/vendor/README.md).

## Roadmap

Everything from the original roadmap has shipped. New ideas are tracked as
GitHub issues.
