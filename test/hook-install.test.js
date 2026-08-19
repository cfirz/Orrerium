import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EVENTS, applyInstall, applyUninstall, emitCommand, install } from '../hooks/install.js';
import { applyInstall as applyInstallFor, installJson } from '../hooks/installers/shared.js';
import { gemini } from '../hooks/installers/gemini.js';
import { applyCodexToml, installToml, notifyLine } from '../hooks/installers/codex.js';

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

// --- gemini: the same JSON merge against its descriptor --------------------

test('gemini install wires its six events with ms timeouts and the source tag', () => {
  const file = path.join(dir, 'gemini', 'settings.json');
  const result = installJson({ settingsPath: file, emitPath, tool: gemini });
  assert.equal(result.changed, true);
  for (const event of gemini.events) assert.equal(result.changes[event], 'added');
  const settings = readSettings(file);
  assert.deepEqual(Object.keys(settings.hooks), gemini.events);
  const hook = settings.hooks.BeforeTool[0].hooks[0];
  assert.equal(hook.timeout, 5000); // Gemini CLI counts in milliseconds
  assert.ok(hook.command.endsWith('--source=gemini-cli'));
  assert.equal('matcher' in settings.hooks.BeforeTool[0], false); // absent = every tool

  // idempotent second run, merge-preserving like the claude path
  const again = installJson({ settingsPath: file, emitPath, tool: gemini });
  assert.equal(again.changed, false);
});

test('gemini repairs an entry that lost its --source tag', () => {
  const flagless = {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: emitCommand(emitPath), timeout: 5000 }] }] },
  };
  const { settings, changes } = applyInstallFor(flagless, emitPath, gemini);
  assert.equal(changes.SessionStart, 'updated');
  assert.ok(settings.hooks.SessionStart[0].hooks[0].command.endsWith('--source=gemini-cli'));
});

test('gemini uninstall leaves user hooks and other tools untouched', () => {
  const file = path.join(dir, 'gemini-un', 'settings.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: 'node mine.js' }] }] },
  }), { flag: 'wx' });
  installJson({ settingsPath: file, emitPath, tool: gemini });
  const result = installJson({ settingsPath: file, emitPath, tool: gemini, uninstall: true });
  assert.equal(result.changes.BeforeTool, 'removed');
  const settings = readSettings(file);
  assert.deepEqual(Object.keys(settings.hooks), ['BeforeTool']);
  assert.equal(settings.hooks.BeforeTool[0].hooks[0].command, 'node mine.js');
});

// --- codex: the conservative TOML line edit --------------------------------

test('codex: notify appended to an empty or top-level-only config', () => {
  assert.deepEqual(applyCodexToml('', emitPath), {
    text: `${notifyLine(emitPath)}\n`, change: 'added',
  });
  const { text, change } = applyCodexToml('model = "gpt-5.6-terra"\n', emitPath);
  assert.equal(change, 'added');
  assert.equal(text, `model = "gpt-5.6-terra"\n${notifyLine(emitPath)}\n`);
});

test('codex: notify lands in the top-level block, before any [section]', () => {
  const { text } = applyCodexToml('model = "x"\n\n[profiles.fast]\nmodel = "y"\n', emitPath);
  const notifyAt = text.indexOf('notify = ');
  assert.ok(notifyAt >= 0 && notifyAt < text.indexOf('[profiles.fast]'));
});

test('codex: rewrites a stale clone path, no-ops when current', () => {
  const stale = `notify = ["node", "/old/clone/Orrerium/hooks/emit.js", "--source=codex"]\n`;
  const { text, change } = applyCodexToml(stale, emitPath);
  assert.equal(change, 'updated');
  assert.ok(text.startsWith(notifyLine(emitPath)));
  assert.equal(applyCodexToml(text, emitPath).change, 'ok');
});

test('codex: a foreign notify is refused, and a section-level notify does not count', () => {
  assert.throws(
    () => applyCodexToml('notify = ["terminal-notifier"]\n', emitPath),
    /exactly one/,
  );
  // notify under a [section] belongs to that section, not the top level
  const { change } = applyCodexToml('[whatever]\nnotify = ["theirs"]\n', emitPath);
  assert.equal(change, 'added');
});

test('codex: uninstall removes only our line; foreign and absent are none', () => {
  const ours = `${notifyLine(emitPath)}\nmodel = "x"\n`;
  const removed = applyCodexToml(ours, emitPath, { uninstall: true });
  assert.equal(removed.change, 'removed');
  assert.equal(removed.text.includes('notify'), false);
  assert.equal(applyCodexToml('model = "x"\n', emitPath, { uninstall: true }).change, 'none');
  assert.equal(applyCodexToml('notify = ["theirs"]\n', emitPath, { uninstall: true }).change, 'none');
});

test('codex: installToml writes atomically with a backup, dry run writes nothing', () => {
  const file = path.join(dir, 'codex', 'config.toml');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'model = "x"\n', { flag: 'wx' });
  const dry = installToml({ settingsPath: file, emitPath, dryRun: true });
  assert.equal(dry.changed, true);
  assert.equal(readFileSync(file, 'utf8'), 'model = "x"\n');
  const result = installToml({ settingsPath: file, emitPath });
  assert.equal(result.changes.notify, 'added');
  assert.ok(result.backupPath && existsSync(result.backupPath));
  assert.ok(readFileSync(file, 'utf8').includes(notifyLine(emitPath)));
  // a foreign notify aborts before any write
  writeFileSync(file, 'notify = ["theirs"]\n');
  assert.throws(() => installToml({ settingsPath: file, emitPath }), /exactly one/);
  assert.equal(readFileSync(file, 'utf8'), 'notify = ["theirs"]\n');
});
