---
name: pixel-garden
description: "Weekend game prototype — a grid garden that grows in real time while the app is closed."
type: project
dir: "~/code/pixel-garden"
updated: 2026-08-17
tags: [git]
status: active
---

Idle-garden prototype: plants advance on wall-clock time, so reopening the app after a day is
the payoff moment. Prototype quality — one scene, no persistence migrations yet.

- **Path:** `~/code/pixel-garden`
- **Stack:** TypeScript + canvas, no engine
- **Canonical docs:** `~/code/pixel-garden/CLAUDE.md` — read that, not this, when working *in* the project.
- **Git:** yes

**What a different project's session should know:** the growth simulation is deterministic from
(seed, elapsed time) — never store computed plant state, only the seed and timestamps.

Related: [[orbit-tracker]]

## What links here (Dataview — additive only)

```dataview
LIST WHERE contains(projects, this.file.link)
```
