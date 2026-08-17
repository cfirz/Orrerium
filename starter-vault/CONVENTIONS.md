# Conventions

Rules for every note in this vault. Read once before writing your first note; follow always.

## The retrieval contract

The vault's only search mechanism is:

```
rg "^description:" <path-to-this-vault> -g "*.md"
```

One line per note comes back. An agent reads that output, then opens the 1–5 files that matched.
Everything below exists to keep that contract working.

**Hard rule:** `description` is one sentence on **one physical line**, always double-quoted.
Never wrapped, never a YAML block scalar (`>` or `|`). A wrapped description is invisible to search.

**The exception:** files in `templates/` carry **no `description:` field at all** — a placeholder
that gets overwritten on instantiation is not a note, and it would surface as a phantom hit in
every search. Fill the description in when you copy the template out, not before. The same logic
exempts templates from `name` == stem: their `name:` is a placeholder slug (`lesson-slug`),
filled in on instantiation.

**Why the type folders exist.** Not navigation — search scope. The whole-vault `rg` returns one
line per note, so its cost grows with the vault; past ~150 notes an unscoped search is a
meaningful slice of a session's context. Pointing the same command at one folder
(`rg "^description:" <path-to-this-vault>/lessons -g "*.md"`) is the mitigation, and it only
works while every note lives in the folder its `type` names. So: do not flatten this vault into a
single `notes/` directory, and do not add a second level of folders inside a type — both break
the scoping. Keep folders shallow, few, and exactly aligned with `type`.

## Frontmatter schema

```yaml
---
name: fs-watch-fires-twice-per-save   # required — == filename without .md == wikilink target
description: "One sentence, one physical line, always quoted."   # required
type: lesson                          # required — project | lesson | machine | idea | template
dir: "~/code/orbit-tracker"           # required on project pages only — the code dir on disk
updated: 2026-08-17                   # required — date of last substantive edit
tags: [git, gotcha]                   # optional
projects: ["[[orbit-tracker]]"]       # optional — which project(s) this came from / applies to
status: active                        # optional — active | stale
---
```

- `name` is a kebab-case slug, identical to the filename stem. No spaces anywhere in the vault.
- `type` matches the folder the note lives in (`projects/` → `project`, etc.).
- `dir` is required on any project page that maps a single code dir; a page that spans many
  dirs deliberately carries none.
- `projects:` is what makes the graph cluster by project — frontmatter wikilinks are real graph
  edges. Put it on any lesson, machine or idea note that is project-scoped; omit it on
  machine-wide notes.

## Two kinds of fact: `lessons/` vs `machine/`

The split is by **lifetime, not topic**. A `lessons/` note stays true on a different machine;
a `machine/` note is about this box — versions, ports, absolute paths, install quirks — and a new
laptop invalidates all of it at once. Sorting by lifetime is what makes "I replaced the machine"
a review of one folder instead of a review of the vault. When a note has both halves, split it:
the transferable claim goes in `lessons/`, the local specifics in `machine/`, linked both ways.

## Going stale

Staleness goes in the **description**, not just the frontmatter, because the description line is
the only thing search shows — and the moment an agent is choosing which files to open is the only
moment the warning matters. Prefix the description text with `STALE (YYYY-MM) — `, so the search
output itself reads:

    .../machine/local-dev-ports.md:description: "STALE (2026-06) — port map predates..."

(Indented, not fenced, deliberately: a `description:` at column 0 in this file would show up in
every whole-vault search as a phantom note. The schema block above already costs one such line,
and the two `SKILL.md` files under `.claude/` cost two more when the search runs through a tool
that descends hidden dirs — plain `rg` skips them. Don't add more.)

Set `status: stale` in the same edit as the prefix. Never delete a note for being outdated: a
wrong-but-labelled fact is how you recognise the situation next time. There is no `archive/`
folder and no `archived` status — the prefix does that job without a second search path to
remember.

## Body shape

Open with a bare declarative statement of the fact. Then, as needed:

- `**Why:**` — the mechanism or evidence behind the fact.
- `**How to apply:**` — what an agent should actually do with it.
- Ad-hoc bold labels are fine (`**Fixed 2026-08-17.**`, `**Consequence:**`) — `Why` and an actionable closer are the constants.
- Cross-references go in a trailing `Related: [[slug]], [[slug]]` clause on the last paragraph.
- Link liberally: a `[[slug]]` with no file yet marks a note worth writing, not an error.

## Project pages: link, never duplicate

A project page holds only what a *different* project's session would want to know, plus a link to
the canonical `CLAUDE.md` by absolute path. Duplicating a project's own docs here is the vault's
biggest rot risk — don't.

## The round-trip contract

Facts live where they are verifiable. The code dir owns `stack` and `git`; the Brain page owns the
pointer. Each side names the other in frontmatter, so the mapping is greppable in both directions:

```
rg "^dir:" <path-to-this-vault>/projects -g "*.md"      # vault → disk
rg "^brain:" <your-code-roots> -g CLAUDE.md             # disk → vault
```

Both must return the same set of pairings. Any asymmetry is drift — fix it rather than reconciling
by hand. A project dir earns frontmatter in its `CLAUDE.md` once you actually work in it; dead and
vendored dirs stay as rows in an inventory page and get nothing.

## Capture and maintenance

The two workflows are versioned with the vault as skills, so they travel with it rather than
living in one machine's global config:

- [`.claude/skills/capture`](.claude/skills/capture/SKILL.md) — one entry appended to
  [inbox.md](inbox.md): a short fact paragraph plus a provenance line. No naming, no filing,
  no frontmatter.
- [`.claude/skills/triage`](.claude/skills/triage/SKILL.md) — batch-promote the inbox to real
  notes, on a **threshold (~5 entries), not a schedule**.

The rules they enforce:

- **Filter:** it goes in the Brain if it cost more than ~30 minutes, or you worked it out twice. Nothing else.
- A tag exists once a *third* note needs it — no taxonomy up front.
- Non-goals: daily notes, review cadences, MOCs, archive folders.

Skills auto-load only in sessions whose project dir is this vault. Sessions in a code repo can get
the capture *trigger* from a global `~/.claude/CLAUDE.md` that points back here for the
procedure — keep that pointer alive if either file moves.

## Obsidian (optional, additive)

The vault must stay fully usable as flat files. If Obsidian is installed later: wikilinks on,
shortest-path links, template folder `templates/`, Dataview allowed only *beneath* hand-written
static content, never replacing it. (Install Dataview from Obsidian's community plugins if you
want the live index views — nothing here depends on it.)
