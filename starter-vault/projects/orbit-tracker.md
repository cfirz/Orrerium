---
name: orbit-tracker
description: "Browser app that plots satellite passes over your location; vanilla JS front end, zero-dep Node server."
type: project
dir: "~/code/orbit-tracker"
updated: 2026-08-17
tags: [git]
status: active
---

Single-page satellite tracker: pick a spot on the map, get tonight's visible passes. No build
step, no framework — the server serves static files and one JSON API.

- **Path:** `~/code/orbit-tracker`
- **Stack:** Node 20, vanilla ES modules
- **Canonical docs:** `~/code/orbit-tracker/CLAUDE.md` — read that, not this, when working *in* the project.
- **Git:** yes

**What a different project's session should know:** the TLE parser is the only reusable module;
it is pure and lives in `lib/tle.js`. The dev server assumes port 8080 — see
[[local-dev-ports]].

Related: [[fs-watch-fires-twice-per-save]]

## What links here (Dataview — additive only)

```dataview
LIST WHERE contains(projects, this.file.link)
```
