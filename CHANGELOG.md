# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Subagent activity on the Brain graph. Sessions with subagents in
  flight hold a 15-minute lease instead of the 90s stale window, the
  snapshot carries a `waiting` count ("Waiting on 2 subagents" instead
  of "idle — turn ended"), and each live node grows a second
  counter-rotating ring of one dot per agent in flight.
- Subagents whose type has no node of its own — the built-ins
  (`general-purpose`, `Explore`, `Plan`, …) have no
  `.claude/agents/*.md` file, so nothing on the graph to light — are
  counted on their orchestrator's node instead of vanishing, and their
  spawn ripples it.

### Fixed

- `SubagentStop` no longer retires a subagent that is still running:
  it fires at turn end whether a subagent ran or not (9 of 11 in a
  day's logs followed a `Stop` in sessions that spawned nothing), so
  stops past the cumulative spawn count now close nothing. Blocking
  `Agent` calls close exactly on their own `PostToolUse` instead —
  the call does not return until the subagent finishes — and every
  backgrounded spawn carries a lease so a lost completion cannot light
  a node forever.

## [0.3.0] - 2026-08-19

### Added

- Ask-your-brain answers stream in as they generate, from both providers
  (Claude API and `claude` CLI). `POST /api/ask` with `"stream": true`
  relays the answer as NDJSON delta lines; the plain JSON shape is
  unchanged for scripts.
- Stop button on the ask box: cancels the in-flight answer mid-stream,
  aborts the provider call server-side, and drops the stopped turn from
  the conversation.
- `folderTypes` in `config.json` maps custom folder names (PARA,
  Zettelkasten, …) onto the five built-in note types; the graph, boards
  and colours follow the mapping with no other changes.
- Vaults too big for one context window now go through a local retrieval
  step: BM25 over the notes plus one hop along their wikilinks, filling
  the `ai.maxContextTokens` budget (default 120k). Smaller vaults still
  ship whole and keep the prompt-cache win.
- Stats panel (`#/stats`), backed by `GET /api/stats`: per-day usage
  rollups over the last fortnight's logs — sessions (interactive vs
  cron), tool calls, errors, subagent spawns, active time, top tools,
  cron run health, and ask usage by model.
- Multi-provider ask-your-brain: `ai.provider` now also takes `openai`,
  `gemini`, `grok`, and `ollama` — one OpenAI-compatible adapter behind a
  provider registry, keys environment-only (`OPENAI_API_KEY`,
  `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `XAI_API_KEY`), with new `ai.baseUrl`
  and `ai.keyEnv` overrides for local models and proxies. A missing key now
  fails fast with a message naming the env var instead of a provider 401.
- Agents board sources: every hook event carries a `source`
  (`claude-code` by default), `POST /api/hook-event?source=<slug>` selects
  a per-tool dialect adapter, and any tool can feed the board with a small
  normalized event shape. Cards wear source badges and a source filter row
  appears once a second tool reports.
- Hook installers for other CLIs: `node hooks/install.js --tool gemini`
  wires Gemini CLI (`~/.gemini/settings.json`), `--tool codex` sets Codex
  CLI's `notify` in `~/.codex/config.toml` (turn-complete cards — all Codex
  exposes), and `--print` emits the snippet for manual wiring.

### Changed

- Ask answers report the actual model the `claude` CLI session used instead
  of the "claude-cli default" placeholder (streaming runs only; buffered
  text mode has no way to know).
- `/api/ask` responses name the provider by service (`anthropic`, `openai`,
  `gemini`, `grok`, `ollama`, `cli`); `"api"` remains accepted in config as
  an alias for `anthropic`, and `ai.model` now defaults per provider
  instead of globally to `claude-opus-5`.

### Fixed

- Oversized POST bodies now receive a 413 response instead of a silently
  dropped connection.

## [0.2.0] - 2026-08-18

### Added

- Motion toggle in the graph view, so machines with the OS reduced-motion
  setting enabled can still watch live agent traffic.
- Hook installer that wires up the Agents board in one command.
- CI workflow running `node --test` on Linux, macOS, and Windows, with a
  status badge in the README.
- Contributor guidelines and a security policy.
- Step-by-step first-time setup guide with command snippets and a
  troubleshooting section.
- Animated README hero showing live agent traffic on the graph.

### Changed

- **Renamed the project from BrainOS to Orrerium.**
- Graph motion now defaults to On instead of following the OS
  reduced-motion setting.

### Security

- The `claude` CLI is now spawned directly, without going through a shell.

## [0.1.0] - 2026-08-17

### Added

- Initial public release (as BrainOS): a local-first, read-only dashboard
  over a markdown knowledge vault.
- Interactive graph view of the vault, updating live via `fs.watch`.
- Projects board, inbox view, and ask-your-brain.
- Bundled demo vault in `starter-vault/`, used by default; `ORRERIUM_VAULT`
  or `config.json` selects a real vault.
- Zero-dependency Node server (`node server.js`), with `orrerium.bat` and
  `orrerium.sh` as double-click launchers.

[Unreleased]: https://github.com/cfirz/Orrerium/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/cfirz/Orrerium/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/cfirz/Orrerium/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/cfirz/Orrerium/releases/tag/v0.1.0
