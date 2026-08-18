---
name: orrerium
stack: node
git: true
---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Orrerium is a local-first dashboard over a markdown knowledge vault**: an interactive graph, a
projects board, the inbox view, and ask-your-brain. It ships with a demo vault in
`starter-vault/` and points at it by default; `ORRERIUM_VAULT` or `config.json` selects a real
vault. `README.md` here is the canonical architecture doc — read it before changing anything;
this file only adds what an agent needs first.

## Commands

```bash
node server.js
```

Then open http://127.0.0.1:4321. Node 20+, zero npm dependencies — there is nothing to install.
`orrerium.bat` (Windows) and `orrerium.sh` (macOS/Linux) are the human double-click paths (server +
browser, reuses a running instance); agents should keep using `node server.js` so the log stays
in the foreground.

```bash
node --test
```

## Constraints

- **Zero dependencies is a design rule, not an accident.** No npm installs; third-party code
  goes into `public/vendor/` as committed single-file builds.
- **Never write the vault.** Orrerium reads the vault live over recursive `fs.watch` and stays
  read-only toward it. `.obsidian/graph.json` was a design reference for colours/forces and is
  never read or written at runtime (Obsidian clobbers it).
- `lib/vault.js` and `lib/graph.js` are pure and importable by agents and CLIs — keep
  http and `fs.watch` out of them.
