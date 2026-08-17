---
name: utf8-bom-breaks-frontmatter-parsing
description: "A UTF-8 BOM before the opening --- makes frontmatter parse as body text; strip it before matching."
type: lesson
updated: 2026-08-17
tags: [python]
projects: ["[[recipe-box]]"]
---

A markdown file saved with a UTF-8 BOM does not start with `---` — it starts with `﻿---`,
so any parser that checks `startsWith('---')` silently treats the whole frontmatter block as
document body.

**Why:** Windows Notepad and some export tools write the BOM by default; the file looks
identical in every editor, which is what makes the failure invisible until a note stops
showing its metadata.

**How to apply:** strip a leading `﻿` before frontmatter detection, and prefer saving as
"UTF-8" (not "UTF-8 with BOM"). One line of defense in the parser beats auditing every file.

Related: [[recipe-box]]
