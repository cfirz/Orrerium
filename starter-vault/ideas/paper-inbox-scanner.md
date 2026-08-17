---
name: paper-inbox-scanner
description: "Phone-photo pipeline that OCRs paper notes straight into inbox.md for normal triage."
type: idea
updated: 2026-08-17
tags: []
status: active
---

Photograph a paper note, OCR it, and append the text to [inbox.md](../inbox.md) as an ordinary
capture entry — so handwritten notes join the same triage flow instead of dying in a drawer.
Open questions: which OCR runs locally (the vault is local-first, shipping photos to a cloud
API is against the grain), and whether the provenance line can be auto-filled from the photo's
timestamp. Nothing exists yet; a shortcut + small script would be a fine first cut.

Related: [[vault-stats-dashboard]]
