import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAskHistory } from '../lib/ask-history.js';

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'orrerium-askhist-'));

// a clock that ticks forward on every call, so updatedAt ordering is stable
function ticker(start = 1_700_000_000_000, step = 1000) {
  let t = start - step;
  return () => (t += step);
}

test('record: no id creates a conversation with title and both turns', () => {
  const hist = createAskHistory({ dataDir: tempDir(), now: () => 42_000 });
  const conv = hist.record({ question: 'what is sqlite locking?', answer: 'WAL mode…', provider: 'api', model: 'claude-sonnet-4-5' });
  assert.match(conv.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.equal(conv.title, 'what is sqlite locking?');
  assert.deepEqual(conv.turns, [
    { role: 'user', content: 'what is sqlite locking?' },
    { role: 'assistant', content: 'WAL mode…' },
  ]);
  assert.equal(conv.startedAt, 42_000);
  assert.equal(conv.updatedAt, 42_000);
  assert.equal(conv.provider, 'api');
});

test('record: existing id appends a pair, bumps updatedAt, keeps title/startedAt', () => {
  const hist = createAskHistory({ dataDir: tempDir(), now: ticker() });
  const first = hist.record({ question: 'q1', answer: 'a1', provider: 'cli', model: null });
  const second = hist.record({ id: first.id, question: 'q2', answer: 'a2', provider: 'api', model: 'm' });
  assert.equal(second.id, first.id);
  assert.equal(second.turns.length, 4);
  assert.equal(second.title, 'q1');
  assert.equal(second.startedAt, first.startedAt);
  assert.ok(second.updatedAt > first.startedAt);
  assert.equal(hist.list().length, 1);
});

test('record: unknown id reconstructs the thread from client history', () => {
  const hist = createAskHistory({ dataDir: tempDir(), now: ticker() });
  const conv = hist.record({
    id: 'gone-from-server',
    history: [{ role: 'user', content: 'earlier q' }, { role: 'assistant', content: 'earlier a' }],
    question: 'follow-up', answer: 'sure', provider: 'api', model: 'm',
  });
  assert.notEqual(conv.id, 'gone-from-server'); // server issues a fresh id
  assert.deepEqual(conv.turns.map((t) => t.content), ['earlier q', 'earlier a', 'follow-up', 'sure']);
  assert.equal(conv.title, 'earlier q'); // titled from the first user turn
});

test('record: title truncated to 80 chars', () => {
  const hist = createAskHistory({ dataDir: tempDir(), now: ticker() });
  const conv = hist.record({ question: 'x'.repeat(200), answer: 'a' });
  assert.equal(conv.title.length, 80);
});

test('list: newest-updated first, summaries carry turnCount but no turns', () => {
  const hist = createAskHistory({ dataDir: tempDir(), now: ticker() });
  const older = hist.record({ question: 'old', answer: 'a' });
  const newer = hist.record({ question: 'new', answer: 'a' });
  hist.record({ id: older.id, question: 'follow-up', answer: 'a' }); // bump older
  const listed = hist.list();
  assert.deepEqual(listed.map((c) => c.id), [older.id, newer.id]);
  assert.equal(listed[0].turnCount, 4);
  assert.equal('turns' in listed[0], false);
});

test('get: round-trips full turns, unknown id is null', () => {
  const hist = createAskHistory({ dataDir: tempDir(), now: ticker() });
  const conv = hist.record({ question: 'q', answer: 'a' });
  assert.deepEqual(hist.get(conv.id).turns, conv.turns);
  assert.equal(hist.get('nope'), null);
});

test('remove deletes; survivors persist across a fresh factory', () => {
  const dataDir = tempDir();
  const hist = createAskHistory({ dataDir, now: ticker() });
  const keep = hist.record({ question: 'keep me', answer: 'a' });
  const drop = hist.record({ question: 'drop me', answer: 'a' });
  const remaining = hist.remove(drop.id);
  assert.deepEqual(remaining.map((c) => c.id), [keep.id]);

  const reopened = createAskHistory({ dataDir, now: ticker() });
  assert.deepEqual(reopened.list().map((c) => c.id), [keep.id]);
  assert.equal(reopened.get(keep.id).title, 'keep me');
});

test('pruning: conversation count capped, oldest-updated dropped', () => {
  const hist = createAskHistory({ dataDir: tempDir(), now: ticker(), maxConversations: 3 });
  const first = hist.record({ question: 'first', answer: 'a' });
  hist.record({ question: 'second', answer: 'a' });
  hist.record({ question: 'third', answer: 'a' });
  hist.record({ question: 'fourth', answer: 'a' });
  const listed = hist.list();
  assert.equal(listed.length, 3);
  assert.equal(hist.get(first.id), null); // oldest fell off
  assert.deepEqual(listed.map((c) => c.title), ['fourth', 'third', 'second']);
});
