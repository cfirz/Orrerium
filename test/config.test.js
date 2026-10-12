import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig } from '../lib/config.js';
import { DEFAULT_FOLDER_TYPES } from '../lib/vault.js';

// mergeConfig is the pure half of loadConfig - these tests never touch the
// real config.json or the filesystem

test('empty raw config gets every default', () => {
  const config = mergeConfig({});
  assert.equal(config.port, 4321);
  assert.deepEqual(config.folderTypes, DEFAULT_FOLDER_TYPES);
  assert.deepEqual(config.claudeScan.roots, []);
});

test('nested sections merge one level deep', () => {
  const config = mergeConfig({ claudeScan: { rescanMs: 1000 } });
  assert.equal(config.claudeScan.rescanMs, 1000);
  assert.ok(config.claudeScan.globalDir); // sibling default survives
});

test('eventRetentionDays defaults to 90 and must be a whole number', () => {
  assert.equal(mergeConfig({}).eventRetentionDays, 90);
  assert.equal(mergeConfig({ eventRetentionDays: 0 }).eventRetentionDays, 0);
  assert.throws(() => mergeConfig({ eventRetentionDays: -1 }), /whole number/);
  assert.throws(() => mergeConfig({ eventRetentionDays: '30' }), /whole number/);
  assert.throws(() => mergeConfig({ eventRetentionDays: 7.5 }), /whole number/);
});

test('a leftover ai block from before 0.5.0 is dropped, not merged', () => {
  const config = mergeConfig({ ai: { provider: 'anthropic' } });
  assert.equal(config.ai, undefined);
});

test('a provided folderTypes map replaces the default wholesale', () => {
  const config = mergeConfig({ folderTypes: { docs: 'idea' } });
  assert.deepEqual(config.folderTypes, { docs: 'idea' }); // no projects/lessons left
});

test('folderTypes values outside the five types are rejected with the list', () => {
  assert.throws(
    () => mergeConfig({ folderTypes: { notes: 'note' } }),
    /folderTypes\["notes"\] is "note" — valid types are: project, lesson, machine, idea, template/,
  );
});

test('a non-object folderTypes is rejected', () => {
  assert.throws(() => mergeConfig({ folderTypes: ['projects'] }), /must be an object/);
  assert.throws(() => mergeConfig({ folderTypes: null }), /must be an object/);
});
