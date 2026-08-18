import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendLine, readJson, readLines, writeJson } from '../lib/store.js';

const dir = mkdtempSync(path.join(tmpdir(), 'orrerium-store-'));

test('writeJson/readJson round-trip, creating parent dirs', () => {
  const file = path.join(dir, 'nested', 'doc.json');
  writeJson(file, { a: 1, b: ['x'] });
  assert.deepEqual(readJson(file, null), { a: 1, b: ['x'] });
});

test('readJson falls back on missing or mangled files', () => {
  assert.deepEqual(readJson(path.join(dir, 'nope.json'), { d: true }), { d: true });
  const bad = path.join(dir, 'bad.json');
  appendFileSync(bad, '{ torn');
  assert.equal(readJson(bad, 'fallback'), 'fallback');
});

test('appendLine/readLines NDJSON log, torn tail line dropped', () => {
  const log = path.join(dir, 'log', 'events.ndjson');
  appendLine(log, { n: 1 });
  appendLine(log, { n: 2 });
  appendFileSync(log, '{"n": 3'); // crash mid-append
  assert.deepEqual(readLines(log), [{ n: 1 }, { n: 2 }]);
});

test('readLines on a missing file is an empty array', () => {
  assert.deepEqual(readLines(path.join(dir, 'missing.ndjson')), []);
});
