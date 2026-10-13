# Orrerium

[![CI](https://github.com/cfirz/Orrerium/actions/workflows/ci.yml/badge.svg)](https://github.com/cfirz/Orrerium/actions/workflows/ci.yml)

Watch your coding agents work across your knowledge graph. Orrerium draws your
markdown vault as an orrery — projects, lessons and machine notes on concentric
rings — and lights it up live as [Claude Code](https://claude.com/claude-code)
sessions run: the project a session is in glows, dots fly out to the agents doing
its work, and a ring of sparks counts the subagents in flight.

Local-first and fully offline: no build step, zero npm dependencies, no API keys,
nothing leaves your machine. All state is plain files that humans and agents can
both read.

![The Brain graph over an example vault: notes on the inner rings, the machine's skills, agents and commands on the outer ones, and two projects lit up cyan, sending dots out to the agent nodes of their working subagents, each of which flashes as a dot arrives](docs/screenshot.gif)

*Above, animated and live: an example vault — 23 lessons, 9 project pages,
7 machine notes — plus a scanned Claude Code setup across eight repos. Two
projects are delegating, six subagents on a WebGL game repo and four on a kids'
game, while a third session quietly triages the vault's own inbox. Dots travel
from each project out to the agents doing its work, and a node flashes as each
dot reaches it. The tight cyan ring marks a node that is live right now; the
wider, counter-rotating one carries a dot per subagent working there.*

## Quick start

Requires [Node.js](https://nodejs.org) 20 or newer (`node -v`). There is nothing
to install.

```
git clone https://github.com/cfirz/Orrerium
cd Orrerium
node server.js
```

Then open http://127.0.0.1:4321. (No git? **Code → Download ZIP** on GitHub works
too.) Prefer a double-click? [orrerium.bat](orrerium.bat) (Windows) and
[orrerium.sh](orrerium.sh) (macOS/Linux) start the server, open the browser once
it answers, and reuse an instance that is already running.

The first launch opens on the bundled [starter vault](starter-vault/) with a
**demo** playing: scripted sessions light up the graph and fill the Agents,
Flows and Stats panels, so you can see what Orrerium does before wiring anything.
A `demo` badge in the topbar marks it, and it stops for good the moment your
first real session reports.

## Watch your own agents

Run the hook installer once from your clone:

```
node hooks/install.js
```

It merges hook entries into `~/.claude/settings.json` after showing the plan and
asking, backs the file up first, and leaves every other setting and hook alone.
Already-running sessions pick the hooks up on their next restart. The hooks run
[hooks/emit.js](hooks/emit.js), a relay that always exits 0 and swallows every
failure, so your sessions never notice whether Orrerium is running.

- `--tool gemini` wires Gemini CLI (prompts and tool activity); `--tool codex`
  wires Codex CLI, which only reports finished turns, so its cards are coarse.
- `--dry-run` previews, `--uninstall` takes the hooks back out, `--print` emits
  the snippet for wiring by hand ([details](docs/internals.md#wiring-claude-code-by-hand)).
- **Anything else** — CI jobs, your own orchestrator, the Agent SDK — can POST
  events to `/api/hook-event?source=<its-slug>` in this shape (`event` is one of
  `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `SubagentStop`, `Stop`, `SessionEnd`; everything else is optional):

  ```json
  { "ts": 1755500000000, "event": "PreToolUse", "sessionId": "run-42",
    "cwd": "/repo", "tool": "compile", "input": { "command": "make" } }
  ```

A session lights the project note whose `dir` frontmatter matches its working
directory. To map your whole machine's agent setup onto the graph, set
`claudeScan.roots` (below): every repo's `.claude/{skills,agents,commands}` and
your global `~/.claude` then land on the outer rings, and subagents light their
own agent nodes.

## The panels

- **Brain** — the graph, with search, a note reader, Rings and Force layouts, and
  the live agent activity.
- **Agents** — every session on the machine, live: current activity, subagents
  and their status, tool and error counts. Filter by Live / Idle / Ended, and by
  source once a second tool reports.
- **Flows** — replays any session from the last fortnight as a timeline:
  subagent lanes above the orchestrator, tool ticks, a scrubber.
- **Stats** — the fortnight in tiles and a per-day chart: sessions, tool calls,
  errors, subagent spawns, active time, top tools.
- **Projects** — a board built from project-page frontmatter.
- **Inbox** — your vault's `inbox.md` capture buffer; the tab counts waiting
  captures and turns green when it is time to triage.
- **Icons** — give scanned agents hand-drawn pixel faces, shown on the board and
  the graph.

Panels deep-link via the URL hash (`#/agents`, `#/flows`, …).

## Point it at your own vault

Any folder of markdown files works, and Orrerium treats it as **strictly
read-only**. Either set `ORRERIUM_VAULT` when starting the server:

```
ORRERIUM_VAULT=/path/to/your/vault node server.js             # macOS / Linux
$env:ORRERIUM_VAULT="C:\path\to\your\vault"; node server.js   # PowerShell
```

or copy [config.example.json](config.example.json) to `config.json` (gitignored)
and set `vaultPath` (absolute paths; `~` is not expanded).

The graph gets richer with the conventions the bundled
[starter vault](starter-vault/) demonstrates (its
[CONVENTIONS.md](starter-vault/CONVENTIONS.md) explains the why):

- **Type folders** — `projects/`, `lessons/`, `machine/`, `ideas/`, `templates/`
  give a note its type, colour and ring. Other folders still render, untyped;
  `folderTypes` maps different conventions (PARA, Zettelkasten, …) onto the five.
- **A root `README.md`** sits at the centre of the rings.
- **Frontmatter** — `name`, a one-line `description`, `type`, `updated`; project
  pages add `status` and `dir` (the board, and how sessions find their project).
- **`inbox.md`** feeds the Inbox panel, with `capture` and `triage` skills under
  `.claude/skills/`.

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `vaultPath` | `starter-vault` | The vault (relative paths resolve from the repo root; `ORRERIUM_VAULT` overrides) |
| `host` / `port` | `127.0.0.1` / `4321` | Where it listens — keep it on loopback, see [SECURITY.md](SECURITY.md) |
| `excludeDirs` | `.obsidian`, `.claude`, `.git` | Folders never scanned (skills are scanned explicitly) |
| `applicationTags` | `unity`, `python`, … | Tags that become APPLICATION nodes on the outer ring |
| `folderTypes` | `projects` → `project`, … | Folder → note type; a provided map **replaces** the default |
| `claudeScan.roots` | `[]` | Dirs whose children are scanned for `.claude/{skills,agents,commands}`, e.g. `["C:/code"]` |
| `claudeScan.globalDir` | `~/.claude` | The global Claude dir, scanned the same way |
| `claudeScan.settingsPath` | `~/.claude/settings.json` | Read for `skillOverrides`, so disabled skills render dormant |
| `claudeScan.rescanMs` | `300000` | How often external repos are re-scanned |
| `eventRetentionDays` | `90` | Hook-event day logs older than this are deleted; `0` keeps them forever |
| `demo` | `true` | Replay the sample sessions on a first launch; `false` turns it off |

### Troubleshooting

- **`vaultPath is not a directory`** — the path doesn't exist, or `config.json`
  points somewhere stale.
- **`Port 4321 is already in use`** — another instance owns it. Stop it or set
  `port`; hooks then need `ORRERIUM_PORT` set where they run.
- **Errors on startup** — almost always Node older than 20.
- **Agents / Flows / Stats are empty** — expected on your own vault until the
  hooks are installed and a session runs.
- **No spark animations** — your OS asks for reduced motion *and* the graph's
  **motion** toggle is on Auto; set it to **On**.

## API

Everything the UI shows is JSON an agent can read too:

- `GET /api/graph` → `{ generatedAt, vaultPath, nodes, edges, warnings }`
- `GET /api/note/:slug` → `{ id, path, folder, type, frontmatter, markdown }` (also scanned assets, e.g. `DemoApp.qa-agent`)
- `GET /api/agents` → `{ generatedAt, sessions }` — the live board snapshot
- `POST /api/hook-event[?source=<slug>]` — hook payloads. No `source` means `claude-code`; `gemini-cli` and `codex` select their adapters; any other slug reads the generic shape above
- `GET /api/flows` → `{ sessions }` · `GET /api/flows/:sessionId` → `{ sessionId, flow }`
- `GET /api/stats` → `{ generatedAt, days, totals, topTools }`
- `GET /api/icons` · `POST /api/icons/assign` `{ agent, icon|null }` → `{ assignments }`
- `GET /events` → SSE: `vault` (`{ files }`) on every vault change, `agents` (the snapshot) on every hook event, `icons` on every assignment

While the demo plays, `/api/agents`, `/api/flows` and `/api/stats` carry
`demo: true`. How the pieces fit — the event pipeline, subagent accounting, the
graph's animation — is in [docs/internals.md](docs/internals.md).

## Test

```
node --test
```

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
