---
name: local-dev-ports
description: "STALE (2026-06) — port map predates the router change; 4321 Orrerium, 8080 orbit-tracker dev server."
type: machine
updated: 2026-06-30
tags: []
status: stale
---

Local port assignments on this box: 4321 Orrerium, 8080 the [[orbit-tracker]] dev server,
5432 the shared Postgres container.

**Quirks:** written before the router was replaced — the port-forward rules it assumed are
gone, which is why this note carries the STALE prefix instead of being deleted (a
wrong-but-labelled fact is how you recognise the situation next time).

**How to apply:** verify with `lsof -i` / `netstat` before trusting any row here; update the
note and drop the prefix once the map is re-confirmed.

Related: [[node-toolchain]]
