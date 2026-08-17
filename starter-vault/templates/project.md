---
name: project-slug
type: template          # set to: project
dir: "~/code/<dir>"
updated: 2026-08-17
tags: []
status: active
---

One-paragraph orientation: what it is, for whom, current state.

- **Path:** `~/code/<dir>`
- **Stack:**
- **Canonical docs:** `~/code/<dir>/CLAUDE.md` — read that, not this, when working *in* the project.
- **Git:** yes/no

**What a different project's session should know:** the 2–3 facts that leak across
project boundaries (shared conventions, shared dependencies, things it broke elsewhere).

Related: [[slug]]

## What links here (Dataview — additive only)

```dataview
LIST WHERE contains(projects, this.file.link)
```
