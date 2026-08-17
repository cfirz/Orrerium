# Brain

One vault for everything that spans projects on this machine: what each project is,
lessons that transfer between them, machine/toolchain facts, and the idea backlog.
Plain markdown, agent-first — renders in Obsidian, works as flat files.

> This is the **starter vault** bundled with BrainOS — a small, fabricated example of the
> system so the dashboard has something to show on first launch. Copy it somewhere, replace
> the sample notes with your own, and point BrainOS at it (`BRAINOS_VAULT` or `config.json`).

- **Find things:** `rg "^description:" <path-to-this-vault> -g "*.md"` — one line per note.
  Scope it to a folder (`.../lessons`) once you know which kind of note you want.
- **Write things:** read [CONVENTIONS.md](CONVENTIONS.md) first.
- **Capture things:** append an entry to [inbox.md](inbox.md); triage when it holds ~5 entries.

## Index

### Projects (`projects/`)

One page per codebase actively worked in.

- [Orbit Tracker](projects/orbit-tracker.md) — satellite-pass plotter; vanilla JS, zero-dep Node server
- [Recipe Box](projects/recipe-box.md) — CLI recipe manager; Python + SQLite over plain-markdown recipes
- [Pixel Garden](projects/pixel-garden.md) — idle-garden prototype; grows on wall-clock time while closed

### Lessons (`lessons/`)

Cross-project gotchas — the reason this vault exists. Transferable: a lesson stays true
on a different machine, which is what separates it from `machine/`.

- [fs.watch fires twice per save](lessons/fs-watch-fires-twice-per-save.md) — editors write-then-rename; debounce, don't dedupe
- [A UTF-8 BOM breaks frontmatter parsing](lessons/utf8-bom-breaks-frontmatter-parsing.md) — the file starts with an invisible char, not `---`
- [Wikilinks are case-sensitive on Linux](lessons/wikilinks-are-case-sensitive-on-linux.md) — the filesystem case-folds, not the app; keep slug == filename

### Machine (`machine/`)

This box: versions, ports, paths, quirks. Everything here dies with the hardware —
that is the whole reason it is not in `lessons/`.

- [Node toolchain](machine/node-toolchain.md) — Node 20 via nvm, corepack on; GUI launches miss the PATH
- [Local dev ports](machine/local-dev-ports.md) — STALE example: kept, labelled, never deleted

### Ideas (`ideas/`)

Backlog. An idea note is a pitch, not a plan.

- [Vault stats dashboard](ideas/vault-stats-dashboard.md) — notes-per-week by type, from frontmatter alone
- [Paper inbox scanner](ideas/paper-inbox-scanner.md) — OCR phone photos straight into inbox.md

## Live view (Dataview — additive only)

The hand-written index above is canonical; this table is a dynamic complement rendered by
the Dataview plugin, if installed from Obsidian's community plugins (invisible outside Obsidian).

```dataview
TABLE WITHOUT ID file.link AS Note, type AS Type, updated AS Updated
WHERE type AND type != "template"
SORT type ASC, file.name ASC
```
