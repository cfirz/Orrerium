---
name: fs-watch-fires-twice-per-save
description: "Editors save via write-then-rename, so fs.watch sees 2–3 events per save; debounce, don't dedupe."
type: lesson
updated: 2026-08-17
tags: [git]
projects: ["[[orbit-tracker]]"]
---

A single "save" in most editors is a temp-file write followed by a rename, so a recursive
`fs.watch` reports two or three events for one user action — sometimes with different event
types for the same path.

**Why:** atomic-save strategies (VS Code, vim with `backupcopy` default, Obsidian) never write
the target file in place. The watcher is reporting the filesystem truthfully; it is the mental
model of "one save, one event" that is wrong.

**How to apply:** debounce the whole event stream (~100–200 ms) and rescan, rather than trying
to interpret individual events. Per-event dedupe by path still double-fires across the
write/rename pair.

Related: [[orbit-tracker]]
