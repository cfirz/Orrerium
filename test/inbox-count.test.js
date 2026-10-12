import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRIAGE_ENTRIES, inboxEntries } from '../public/js/inbox-count.js';

const STARTER_INBOX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'starter-vault', 'inbox.md');
const HEADER = '# Inbox\n\n<!--\nAppend-only capture buffer.\n\nTriage at ~5 entries.\n-->\n';

test('the starter inbox - header and comment only - holds no entries', () => {
  assert.deepEqual(inboxEntries(readFileSync(STARTER_INBOX, 'utf8')), []);
  assert.equal(TRIAGE_ENTRIES, 5);
});

test('entries are fact paragraphs with their provenance line', () => {
  const md = `${HEADER}
fs.watch fires twice per save; debounce, do not dedupe.
orbit-tracker, lib/watch.js, 2026-10-01

A BOM before --- hides frontmatter from the parser.
recipe-box, importer.py, 2026-10-02
`;
  const entries = inboxEntries(md);
  assert.equal(entries.length, 2);
  assert.match(entries[0], /^fs\.watch fires twice[\s\S]*2026-10-01$/);
});

test('headings of any level are not entries', () => {
  assert.equal(inboxEntries('# Inbox\n\n## This week\n\nA fact.\nsrc, 2026\n\n### Older\n').length, 1);
});

test('every comment is stripped, not just the first, and an unterminated one too', () => {
  const md = `${HEADER}\nA fact.\nsrc, 2026\n\n<!-- a note to self -->\n\nAnother fact.\nsrc, 2026\n\n<!-- never closed\n\nstill inside it`;
  assert.equal(inboxEntries(md).length, 2);
});

test('a fenced code block belongs to the entry above it, blank lines and all', () => {
  const md = `${HEADER}
Node 20 spawn needs shell:false for .cmd shims.
orbit-tracker, 2026-10-03

\`\`\`js
const a = 1;

const b = 2;
\`\`\`

Next fact.
recipe-box, 2026-10-04
`;
  const entries = inboxEntries(md);
  assert.equal(entries.length, 2);
  assert.match(entries[0], /const a = 1;\n\nconst b = 2;/);
});

test('CRLF files count the same', () => {
  const md = '# Inbox\r\n\r\nOne.\r\nsrc\r\n\r\nTwo.\r\nsrc\r\n';
  assert.equal(inboxEntries(md).length, 2);
});
