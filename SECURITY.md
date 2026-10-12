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
- **Nothing leaves your machine.** Orrerium makes no outbound network calls: no LLM
  provider, no telemetry, no API keys. `config.json` and `data/` are gitignored.

## Scope

In scope: anything letting a page, a vault file, or a network peer read or write outside
what is described above. Path traversal out of the vault or `public/`, any endpoint that
writes vault files, XSS in the note renderer that reaches a real vault, or a way for a
web page you visit to call the API all qualify.

Out of scope: the consequences of deliberately binding to a public interface, running
against a vault you do not trust, and anything that requires an attacker who already has
local access to your account.
