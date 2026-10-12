import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchVault } from '../lib/watch.js';

test('a watcher error is logged, not thrown', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orrerium-watch-'));
  const watcher = watchVault(dir, { onChange: () => {} });
  const logged = [];
  const orig = console.error;
  console.error = (msg) => logged.push(msg);
  try {
    // with no 'error' listener this emit would throw - the uncaught exception
    // that a deleted vault folder or an unplugged drive used to be
    assert.doesNotThrow(() => watcher.emit('error', new Error('EPERM: vault gone')));
  } finally {
    console.error = orig;
    watcher.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(logged[0], /vault gone.*live reload stopped/);
});
