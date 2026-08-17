---
name: node-toolchain
description: "Node 20 via nvm; corepack enabled, pnpm for everything except zero-dep repos."
type: machine
updated: 2026-08-17
tags: [git]
---

Node is installed through nvm, default alias pinned to 20. Corepack is enabled, so pnpm
shims exist without a global install.

**Quirks:** anything launched from a GUI (not a shell) misses the nvm PATH entries — launcher
scripts must resolve `node` themselves or hardcode the nvm bin dir.

**How to apply:** `nvm use` in every terminal before running project scripts; zero-dep repos
(like BrainOS) run on bare `node` and need nothing else.

Related: [[local-dev-ports]]
