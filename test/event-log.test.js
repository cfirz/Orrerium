import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEventLog } from '../lib/event-log.js';

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0); // "today" is 2026-10-12
const now = () => NOW;

function withDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'orrerium-log-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const line = (day, n) => `${JSON.stringify({ ts: Date.parse(`${day}T10:00:00Z`) + n, event: 'PreToolUse', sessionId: `s-${day}` })}\n`;
const write = (dir, day, count = 1) => {
  writeFileSync(path.join(dir, `${day}.ndjson`), Array.from({ length: count }, (_, i) => line(day, i)).join(''));
};

test('recent() reads the newest day files, oldest first', () => withDir((dir) => {
  write(dir, '2026-10-10', 2);
  write(dir, '2026-10-11');
  write(dir, '2026-10-12');
  const log = createEventLog({ dir, days: 2, now });
  const events = log.recent();
  assert.deepEqual(events.map((e) => e.sessionId), ['s-2026-10-11', 's-2026-10-12']);
}));

test('recent() re-parses a file only when it changed', () => withDir((dir) => {
  write(dir, '2026-10-11');
  write(dir, '2026-10-12');
  const log = createEventLog({ dir, now });
  const first = log.recent();
  const second = log.recent();
  // unchanged files hand back the very same parsed objects
  assert.equal(second[0], first[0]);
  assert.equal(second[1], first[1]);
  appendFileSync(path.join(dir, '2026-10-12.ndjson'), line('2026-10-12', 1));
  const third = log.recent();
  assert.equal(third.length, 3);
  assert.equal(third[0], first[0]); // yesterday still memoized
  assert.notEqual(third[1], first[1]); // today re-read
}));

test('recent() skips files dated after tomorrow and non-day files', () => withDir((dir) => {
  write(dir, '2026-10-12');
  write(dir, '2026-10-13'); // tomorrow - UTC skew can legitimately produce it
  write(dir, '2100-01-01'); // a pre-0.5 bogus ts
  writeFileSync(path.join(dir, 'notes.ndjson'), line('2026-10-12', 9));
  const log = createEventLog({ dir, days: 2, now });
  assert.deepEqual(log.recent().map((e) => e.sessionId), ['s-2026-10-12', 's-2026-10-13']);
}));

test('recent() on a missing dir is empty, not an error', () => {
  const log = createEventLog({ dir: path.join(tmpdir(), 'orrerium-no-such-dir-xyz'), now });
  assert.deepEqual(log.recent(), []);
});

test('prune() deletes day files older than retentionDays and nothing else', () => withDir((dir) => {
  write(dir, '2026-07-13'); // 91 days old
  write(dir, '2026-07-14'); // exactly 90 days old - kept
  write(dir, '2026-10-12');
  writeFileSync(path.join(dir, 'README.ndjson'), 'x\n');
  writeFileSync(path.join(dir, '2026-01-01.ndjson.bak'), 'x\n');
  const log = createEventLog({ dir, retentionDays: 90, now });
  assert.deepEqual(log.prune(), ['2026-07-13.ndjson']);
  assert.deepEqual(readdirSync(dir).sort(), ['2026-01-01.ndjson.bak', '2026-07-14.ndjson', '2026-10-12.ndjson', 'README.ndjson']);
}));

test('prune() with retentionDays 0 keeps everything', () => withDir((dir) => {
  write(dir, '2020-01-01');
  const log = createEventLog({ dir, retentionDays: 0, now });
  assert.deepEqual(log.prune(), []);
  assert.ok(existsSync(path.join(dir, '2020-01-01.ndjson')));
}));
