---
name: capture
description: Append a capture entry to the Brain vault inbox. Use at the end of a session where something non-obvious was learned — a gotcha that cost more than ~30 minutes, or a fact worked out for the second time — and whenever the user says "capture this", "add to the brain", or "remember this across projects".
---

# Capture to the Brain inbox

Append to this vault's [inbox.md](../../../inbox.md). Nothing else. No new note, no frontmatter,
no filing into a folder, no README edit — filing is `triage`'s job and doing it here is what
makes capture expensive enough to skip.

## The filter

It goes in only if **it cost more than ~30 minutes, or you worked it out for the second time.**
Everything else is noise that makes the vault worse. If it fails the filter, say so and stop —
do not capture it anyway to be helpful.

Also skip anything the repo already records: code structure, git history, what a `CLAUDE.md`
already says. The vault is for what is *not* derivable from the code.

## The shape

One entry, appended at the end of the file, separated from the previous entry by a blank
line: a short paragraph stating the fact, closed by one provenance line —

```
<the fact, stated flat — what is true and the mechanism behind it, not what you did>
<project, file/path if one exists, date>
```

Keep it as tight as the fact allows — one line is still the ideal — but mechanism that
compression would lose belongs in the capture: triage writes the note from what is here,
not from memory.

Write the fact, not the narrative. `Unity tags are runtime API; renaming one breaks lookups
silently` — not `Spent the afternoon debugging why the player stopped spawning`.

## How to run it

1. Read `inbox.md` first — if the same fact is already there, sharpen that entry instead of
   adding a near-duplicate.
2. Append the entry.
3. If the inbox now holds ~5 entries or more, tell the user it is ready for `triage`. Do not
   triage here, and do not ask to.

Related: `triage` skill, [CONVENTIONS.md](../../../CONVENTIONS.md)
