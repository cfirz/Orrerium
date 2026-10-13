// What counts as an inbox entry, kept import-free so node --test can load it.
// The capture skill defines the shape: a short paragraph stating a fact,
// closed by one provenance line, a blank line between entries. So entries are
// blank-line-separated blocks, except that headings and comments are not
// entries, and a fenced code block is part of the entry it illustrates - its
// own blank lines must not split it, and on its own it is never an entry.

// the capture and triage skills use the same number
export const TRIAGE_ENTRIES = 5;

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^#{1,6}(\s|$)/;

export function inboxEntries(markdown) {
  // every comment, including one left unterminated at the end of the file
  const body = markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const blocks = [];
  let cur = [];
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const open = FENCE_RE.exec(line);
    if (fence) {
      cur.push(line);
      if (open && open[1] === fence) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      cur.push(line);
      continue;
    }
    if (line.trim() === '') {
      if (cur.length) blocks.push(cur);
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur);

  const entries = [];
  for (const lines of blocks) {
    if (lines.every((l) => HEADING_RE.test(l.trim()))) continue;
    const text = lines.join('\n').trim();
    if (FENCE_RE.test(text) && entries.length) {
      entries[entries.length - 1] += `\n\n${text}`;
      continue;
    }
    entries.push(text);
  }
  return entries;
}
