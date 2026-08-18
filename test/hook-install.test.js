import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EVENTS, applyInstall, applyUninstall, emitCommand, install } from '../hooks/install.js';

const dir = mkdtempSync(path.join(tmpdir(), 'orrerium-hooks-'));
const emitPath = path.join('E:', 'somewhere', 'Orrerium', 'hooks', 'emit.js');
const readSettings = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('fresh install creates the settings file with all seven events', () => {
  const file = path.join(dir, 'fresh', 'settings.json');
  const result = install({ settingsPath: file, emitPath });
  assert.equal(result.changed, true);
  assert.equal(result.backupPath, null); // nothing existed to back up
  for (const event of EVENTS) assert.equal(result.changes[event], 'added');
  const settings = readSettings(file);
  assert.deepEqual(Object.keys(settings.hooks), EVENTS);
  // matcher only on the two tool events; command uses forward slashes
  assert.equal(settings.hooks.PreToolUse[0].matcher, '*');
  assert.equal(settings.hooks.PostToolUse[0].matcher, '*');
  assert.equal('matcher' in settings.hooks.SessionStart[0], false);
  const hook = settings.hooks.Stop[0].hooks[0];
  assert.deepEqual(hook, { type: 'command', command: emitCommand(emitPath), timeout: 5 });
  assert.equal(hook.command.includes('\\'), false);
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
});

test('second run is a no-op and writes nothing', () => {
  const file = path.join(dir, 'idempotent', 'settings.json');
  install({ settingsPath: file, emitPath });
  const before = readFileSync(file, 'utf8');
  const again = install({ settingsPath: file, emitPath });
  assert.equal(again.changed, false);
  for (const event of EVENTS) assert.equal(again.changes[event], 'ok');
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(readdirSync(path.dirname(file)).length, 1); // no backup, no tmp
});

test('merge preserves unrelated settings and user hooks, and backs up first', () => {
  const file = path.join(dir, 'merge', 'settings.json');
  const original = {
    model: 'opus',
    permissions: { allow: ['Bash(git status)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node lint.js' }] },
      ],
    },
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(original, null, 2), { flag: 'wx' });
  const result = install({ settingsPath: file, emitPath });
  assert.equal(result.changes.PreToolUse, 'added');
  const settings = readSettings(file);
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.permissions, original.permissions);
  assert.deepEqual(settings.hooks.PreToolUse[0], original.hooks.PreToolUse[0]);
  assert.equal(settings.hooks.PreToolUse[1].matcher, '*');
  assert.ok(result.backupPath && existsSync(result.backupPath));
  assert.deepEqual(readSettings(result.backupPath), original);
});

test('a stale emit.js path from a moved clone is rewritten in place', () => {
  const stale = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node "/old/clone/Orrerium/hooks/emit.js"', timeout: 5 }] }],
    },
  };
  const { settings, changes } = applyInstall(stale, emitPath);
  assert.equal(changes.SessionStart, 'updated');
  assert.equal(changes.UserPromptSubmit, 'added');
  assert.equal(settings.hooks.SessionStart.length, 1); // rewritten, not duplicated
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, emitCommand(emitPath));
});

test('duplicate manual installs collapse to one entry', () => {
  const doubled = {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: emitCommand(emitPath), timeout: 5 }] },
        { hooks: [{ type: 'command', command: 'node "/old/clone/Orrerium/hooks/emit.js"', timeout: 5 }] },
      ],
    },
  };
  const { settings, changes } = applyInstall(doubled, emitPath);
  assert.equal(changes.Stop, 'updated');
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, emitCommand(emitPath));
});

test('uninstall removes only Orrerium hooks and drops emptied events', () => {
  const { settings: installed } = applyInstall({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node lint.js' }] }],
    },
  }, emitPath);
  const { settings, changes } = applyUninstall(installed);
  assert.equal(changes.PreToolUse, 'removed');
  assert.equal(changes.Stop, 'removed');
  assert.deepEqual(Object.keys(settings.hooks), ['PreToolUse']); // user's group survives
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks[0].command, 'node lint.js');
});

test('uninstall on clean settings is a no-op', () => {
  const { settings, changes } = applyUninstall({ model: 'opus' });
  for (const event of EVENTS) assert.equal(changes[event], 'none');
  assert.deepEqual(settings, { model: 'opus' });
});

test('dry run reports the plan but never writes', () => {
  const file = path.join(dir, 'dry', 'settings.json');
  const result = install({ settingsPath: file, emitPath, dryRun: true });
  assert.equal(result.changed, true);
  assert.equal(existsSync(file), false);
});

test('malformed settings JSON aborts before any write', () => {
  const file = path.join(dir, 'broken.json');
  writeFileSync(file, '{ torn', { flag: 'wx' });
  assert.throws(() => install({ settingsPath: file, emitPath }), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ torn');
});

test('a non-array event value is refused rather than clobbered', () => {
  assert.throws(
    () => applyInstall({ hooks: { Stop: { bad: true } } }, emitPath),
    /hooks\.Stop/,
  );
});
