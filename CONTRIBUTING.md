# Contributing to Orrerium

Orrerium is a personal tool published so other people can use it. That shapes which
contributions fit. Bug reports and fixes are very welcome, and so are portability
fixes — it is developed on Windows, so macOS and Linux papercuts are genuinely
useful. Large new features are a harder sell, because every panel has to keep
earning its place in a codebase one person maintains.

**Please open an issue before starting a PR.** This is not a formality: it is the
only way to find out whether something fits the scope before you spend a weekend on
it. An unannounced PR may be turned down on design grounds even when the code is
good, and that is a bad trade for everyone involved.

## Three constraints that are not negotiable

These are design rules, not accidents. A change that breaks one will not be merged
regardless of what else it adds. They also appear in [CLAUDE.md](CLAUDE.md), which is
what AI agents working in this repo read — a change to any of them belongs in both files.

- **Zero npm dependencies.** There is no `node_modules`, and `package.json` has no
  `dependencies` block. Third-party code goes into `public/vendor/` as a committed
  single-file build with its license alongside it — see
  [public/vendor/README.md](public/vendor/README.md). If a change looks like it needs
  a package, that is exactly what to raise in the issue first.
- **Never write the vault.** Orrerium reads the vault over recursive `fs.watch` and
  stays strictly read-only toward it. Someone's notes are their own, and a dashboard
  bug must never be able to corrupt them. Orrerium's own state belongs in `data/`.
- **Keep `lib/vault.js` and `lib/graph.js` pure.** Both are importable by agents and
  CLIs with no server running. No http, no `fs.watch`, no process state.

## Running it

```
node server.js     # http://127.0.0.1:4321, boots against starter-vault/
node --test        # the whole suite, no flags
```

Both work from a fresh clone with nothing installed. There is no build step, no
linter, and no formatter config — match the surrounding code instead.

## Pull requests

- **Tests.** `node --test` must pass. A bug fix should come with a test that fails
  before it; `test/fixtures/vault/` is a mini-vault for parser-level cases.
- **Scope.** One concern per PR. A refactor folded into a fix makes both harder to review.
- **Commits.** The log uses `Area: what changed` — `Flows: compress idle gaps`,
  `Docs: setup guide and troubleshooting`. Sentence case, no trailing period.
- **Docs.** `README.md` is the canonical architecture doc; a change that alters
  behaviour updates it in the same PR.
- **Screenshots.** UI changes are far easier to review with a before/after image.

## AI-assisted contributions

These are fine, and used heavily here — much of Orrerium was written with Claude Code.
The one rule is that you have read and understood what you are submitting, and that it
runs and passes tests on your machine. A PR you cannot explain in review will be
closed: unreviewed generated output costs more to triage than it contributes.

## License

Contributions are accepted under the [MIT License](LICENSE), the same terms as the
project itself. You keep copyright on what you write.
