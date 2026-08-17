---
name: triage
description: Batch-promote the Brain vault's inbox.md into real notes. Use when inbox.md holds roughly 5 entries or more, or when the user asks to triage, file, or clear the brain inbox.
---

# Triage the Brain inbox

Turn accumulated `inbox.md` captures into notes. Triggered by a **threshold (~5 entries), not
a schedule** — a review cadence is an explicit non-goal of this vault.

Read [CONVENTIONS.md](../../../CONVENTIONS.md) before writing anything. It owns the frontmatter
schema and the description rules; this skill only covers the promotion procedure.

## Procedure

1. **Read** this vault's [inbox.md](../../../inbox.md) and the current index in
   [README.md](../../../README.md).
2. **Group** the entries. Several captures often turn out to be one fact with three symptoms —
   that is one note, not three.
3. **Decide a home per group**, by lifetime and scope:
   - `lessons/` — transferable; stays true on a different machine.
   - `machine/` — this box only: versions, ports, absolute paths, install quirks.
   - `projects/` — a pointer fact about one codebase. Link to its `CLAUDE.md`, never
     duplicate what that file already says.
   - `ideas/` — a pitch, not a plan.
   - **Nothing** — captures that turned out to be one-offs, or that the code already records.
     Dropping an entry is a valid outcome; say which ones you dropped and why.
4. **Check for an existing note first.** Sharpening one note beats adding a fifth near-duplicate.
   `rg "^description:" <path-to-this-vault>/<folder> -g "*.md"` — scoped, per
   [CONVENTIONS.md](../../../CONVENTIONS.md).
5. **Write** each new note from `templates/<type>.md`. Filename stem == `name` == wikilink
   target. Link liberally; a `[[slug]]` with no file yet is a note worth writing, not an error.
6. **Update the index** in [README.md](../../../README.md) — hand-written and canonical. A note
   that is not in the index does not exist.
7. **Clear** the promoted entries out of `inbox.md`, leaving anything you deliberately deferred.
8. **Report**: notes created, notes sharpened, entries dropped and why.

## Do not

- Do not invent a tag. A tag exists once a **third** note needs it.
- Do not create a subfolder inside a type folder — it breaks scoped search.
- Do not delete a note for being outdated. Prefix its description with `STALE (YYYY-MM) — `
  and set `status: stale`.

Related: `capture` skill, [CONVENTIONS.md](../../../CONVENTIONS.md)
