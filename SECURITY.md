# Security

Orrerium is a local-first tool. It binds to `127.0.0.1` by default and has no
authentication, no accounts, and no multi-user model. It assumes a single trusted
person on a single machine, and everything below follows from that assumption.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting — **Security → Report a vulnerability**
on this repository. That opens an advisory only the maintainer can see.

Please do not open a public issue for something exploitable. There is one maintainer,
so expect a first response in about a week rather than within hours.

## What to keep in mind when running it

- **Do not expose it to the network.** `host` defaults to `127.0.0.1`. Changing it to
  `0.0.0.0` publishes an unauthenticated read of your entire vault — plus the endpoints
  below — to anyone who can reach the port. For remote access, use an SSH tunnel or an
  authenticating reverse proxy.
- **Crons execute code.** `#/crons` schedules headless `claude -p` runs on your machine
  under your own Claude Code credentials. Anything that can reach the crons API can
  schedule a process. That is the intended feature, and it is why the previous point matters.
- **ask-your-brain sends your whole vault.** Every question ships the vault's full text
  to the configured provider, either the Claude API or the local `claude` CLI. See the
  privacy note under [AI features](README.md#ai-features-optional).
- **The vault is trusted input.** Note contents flow into LLM prompts, so a vault holding
  text you did not write deserves the same caution as any untrusted input to an agent;
  prompt injection is possible in principle.
- **Secrets stay out of the repo.** `config.json` and `data/` are gitignored, and
  `ANTHROPIC_API_KEY` is read from the environment only — it is never written to disk.

## Scope

In scope: anything letting a page, a vault file, or a network peer read or write outside
what is described above. Path traversal out of the vault or `public/`, any endpoint that
writes vault files, XSS in the note renderer that reaches a real vault, or a way to
schedule a cron without local access all qualify.

Out of scope: the consequences of deliberately binding to a public interface, running
against a vault you do not trust, and anything that requires an attacker who already has
local access to your account.
