---
name: recipe-box
description: "Command-line recipe manager; Python + SQLite, imports recipes from plain-markdown files."
type: project
dir: "~/code/recipe-box"
updated: 2026-08-17
tags: [python, git]
status: active
---

CLI for storing and searching household recipes. Recipes are authored as markdown with
frontmatter; the tool indexes them into SQLite for full-text search.

- **Path:** `~/code/recipe-box`
- **Stack:** Python 3.12, SQLite, no web UI
- **Canonical docs:** `~/code/recipe-box/CLAUDE.md` — read that, not this, when working *in* the project.
- **Git:** yes

**What a different project's session should know:** the markdown importer chokes on files saved
with a UTF-8 BOM — see [[utf8-bom-breaks-frontmatter-parsing]]. Runs venv-only; never use the
system Python.

Related: [[wikilinks-are-case-sensitive-on-linux]]

## What links here (Dataview — additive only)

```dataview
LIST WHERE contains(projects, this.file.link)
```
