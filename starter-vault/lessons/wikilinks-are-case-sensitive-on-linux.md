---
name: wikilinks-are-case-sensitive-on-linux
description: "Wikilinks that resolve on Windows/macOS break on Linux — the filesystem does the case-folding, not the app."
type: lesson
updated: 2026-08-17
tags: [obsidian, git]
projects: ["[[recipe-box]]"]
---

A `[[Recipe-Box]]` link to a file named `recipe-box.md` works on Windows and macOS and returns
nothing on Linux. Nothing in the vault changed — only the filesystem underneath it.

**Why:** NTFS and APFS are case-insensitive by default, ext4 is not. Tools that resolve links
by asking the filesystem inherit whichever behavior the host has, so the vault silently holds
links that are broken on half the machines that might read it.

**How to apply:** keep slugs strictly kebab-case and make links match filenames exactly — the
`name` == filename-stem rule in CONVENTIONS.md exists for this. CI or a lint pass on a Linux
box is the cheap way to catch drift.

Related: [[recipe-box]], [[utf8-bom-breaks-frontmatter-parsing]]
