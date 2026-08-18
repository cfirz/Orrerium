# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Ask-your-brain answers stream in as they generate, from both providers
  (Claude API and `claude` CLI). `POST /api/ask` with `"stream": true`
  relays the answer as NDJSON delta lines; the plain JSON shape is
  unchanged for scripts.

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

[Unreleased]: https://github.com/cfirz/Orrerium/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/cfirz/Orrerium/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/cfirz/Orrerium/releases/tag/v0.1.0
