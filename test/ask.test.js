import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVault, parseSkills } from '../lib/vault.js';
import { buildContext, buildSystem, resolveProvider } from '../lib/ask.js';

const FIXTURE_VAULT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');

test('resolveProvider honours explicit setting and auto-detects', () => {
  assert.equal(resolveProvider({ provider: 'api' }), 'api');
  assert.equal(resolveProvider({ provider: 'cli' }), 'cli');

  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    assert.equal(resolveProvider({ provider: 'auto' }), 'api');
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(resolveProvider({ provider: 'auto' }), 'cli');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('buildContext includes notes and skills, excludes templates', () => {
  const { notes } = parseVault(FIXTURE_VAULT);
  const { skills } = parseSkills(FIXTURE_VAULT);
  const ctx = buildContext(notes, skills);

  assert.match(ctx, /## \[\[alpha\]\] \(project/);
  assert.match(ctx, /Test project alpha/);       // description included
  assert.match(ctx, /\*\*Alpha\*\* is the hub/); // body included
  assert.match(ctx, /## \[\[testskill\]\] \(routine\)/);
  assert.doesNotMatch(ctx, /template-note/);     // templates excluded
});

test('buildSystem wraps context and demands wikilink citations', () => {
  const system = buildSystem('THE-CONTEXT');
  assert.match(system, /<vault>\nTHE-CONTEXT\n<\/vault>/);
  assert.match(system, /\[\[note-id\]\]/);
  assert.match(system, /ONLY the vault notes/);
});
