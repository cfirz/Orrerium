// Read side of the hook-event log the agent tracker appends to
// (data/agent-events/YYYY-MM-DD.ndjson). Flows and Stats both want "the last
// fortnight of events" on every request, and re-parsing ~8 MB of NDJSON each
// time was the whole cost of those endpoints - but a past day's file never
// changes once the day is over, so each file is parsed once and kept until its
// (mtime, size) moves. In practice only today's file is ever re-read.
// Retention lives here too: the log is append-only and nothing else deletes it.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { readLines } from './store.js';

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;
const DAY_MS = 86_400_000;
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

export function createEventLog({ dir, days = 14, retentionDays = 90, now = Date.now }) {
  const memo = new Map(); // file name -> { mtimeMs, size, events }

  function dayFiles() {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return []; // nothing logged yet
    }
    return names.filter((n) => DAY_FILE_RE.test(n)).sort();
  }

  function read(name) {
    const file = path.join(dir, name);
    let st;
    try {
      st = statSync(file);
    } catch {
      memo.delete(name);
      return [];
    }
    const hit = memo.get(name);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.events;
    const events = readLines(file);
    memo.set(name, { mtimeMs: st.mtimeMs, size: st.size, events });
    return events;
  }

  return {
    // the newest `days` day files, oldest first, concatenated. A file dated
    // after tomorrow can only come from a bogus ts written before ingest
    // clamped them; it must not squat in the window forever.
    recent() {
      const latest = `${dayOf(now() + DAY_MS)}.ndjson`;
      const names = dayFiles().filter((n) => n <= latest).slice(-days);
      const keep = new Set(names);
      for (const name of memo.keys()) if (!keep.has(name)) memo.delete(name);
      return names.flatMap(read);
    },
    // deletes day files older than retentionDays (0 keeps everything) and
    // returns their names; never touches a file the day pattern does not match
    prune() {
      if (!(retentionDays > 0)) return [];
      const cutoff = `${dayOf(now() - retentionDays * DAY_MS)}.ndjson`;
      const removed = [];
      for (const name of dayFiles()) {
        if (name >= cutoff) break; // sorted: everything after is newer
        try {
          unlinkSync(path.join(dir, name));
          memo.delete(name);
          removed.push(name);
        } catch {
          // locked or already gone - the next prune tries again
        }
      }
      return removed;
    },
  };
}
