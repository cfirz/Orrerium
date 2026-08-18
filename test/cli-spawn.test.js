import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCliInvocation, resolveWindowsCommand } from '../lib/cli-spawn.js';

const PATHEXT = '.COM;.EXE;.BAT;.CMD';

// the resolver appends the PATHEXT entry as spelled, and Windows does not care
// about the casing - so neither do these assertions
const eqPath = (actual, expected, msg) =>
  assert.equal(String(actual).toLowerCase(), String(expected).toLowerCase(), msg);

// a dir with a space in it: the shim path has to survive quoting
function binDir(...files) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'orrerium-bin-')), 'bin dir');
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(path.join(dir, f), '');
  return dir;
}

test('posix: command and args pass through untouched', () => {
  const inv = resolveCliInvocation('claude', ['-p'], { platform: 'linux' });
  assert.deepEqual(inv, { file: 'claude', args: ['-p'], options: {} });
});

test('windows: .exe on PATH is spawned directly, no shell', () => {
  const dir = binDir('claude.EXE');
  const inv = resolveCliInvocation('claude', ['-p'], {
    platform: 'win32',
    env: { PATH: dir, PATHEXT },
  });
  eqPath(inv.file, path.join(dir, 'claude.exe'));
  assert.deepEqual(inv.args, ['-p']);
  assert.deepEqual(inv.options, {});
});

test('windows: PATHEXT order prefers the .exe over the .cmd shim beside it', () => {
  const dir = binDir('claude.cmd', 'claude.exe');
  eqPath(resolveWindowsCommand('claude', { PATH: dir, PATHEXT }), path.join(dir, 'claude.exe'));
});

test('windows: PATH order wins over PATHEXT order', () => {
  const first = binDir('claude.cmd');
  const second = binDir('claude.exe');
  const env = { PATH: `${first};${second}`, PATHEXT };
  eqPath(resolveWindowsCommand('claude', env), path.join(first, 'claude.cmd'));
});

test('windows: a .cmd shim goes through cmd.exe with a quoted path, not shell:true', () => {
  const dir = binDir('claude.cmd');
  const inv = resolveCliInvocation('claude', ['-p', '--output-format', 'text'], {
    platform: 'win32',
    env: { PATH: dir, PATHEXT, ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' },
  });
  assert.equal(inv.file, 'C:\\WINDOWS\\system32\\cmd.exe');
  assert.deepEqual(inv.args.slice(0, 3), ['/d', '/s', '/c']);
  eqPath(inv.args[3], `""${path.join(dir, 'claude.cmd')}" -p --output-format text"`);
  assert.equal(inv.options.windowsVerbatimArguments, true);
});

test('windows: an unresolvable command spawns bare so the caller gets ENOENT', () => {
  const inv = resolveCliInvocation('nope', ['-p'], { platform: 'win32', env: { PATH: binDir(), PATHEXT } });
  assert.deepEqual(inv, { file: 'nope', args: ['-p'], options: {} });
});

test('windows: shell metacharacters in cliCommand stay one literal file name', () => {
  const dir = binDir('claude.cmd');
  const env = { PATH: dir, PATHEXT, ComSpec: 'cmd.exe' };
  // it resolves to nothing, so it is spawned verbatim - never parsed as `&`
  const inv = resolveCliInvocation('claude & calc', ['-p'], { platform: 'win32', env });
  assert.equal(inv.file, 'claude & calc');
  assert.deepEqual(inv.options, {});
});

test('windows: a metacharacter-bearing shim path is quoted inside the cmd line', () => {
  const dir = binDir('cl&ude.cmd');
  const inv = resolveCliInvocation('cl&ude', ['-p'], {
    platform: 'win32',
    env: { PATH: dir, PATHEXT, ComSpec: 'cmd.exe' },
  });
  eqPath(inv.args[3], `""${path.join(dir, 'cl&ude.cmd')}" -p"`);
});

test('windows: an explicit path is used as given, not searched on PATH', () => {
  const dir = binDir('claude.exe');
  const explicit = path.join(dir, 'claude');
  eqPath(resolveWindowsCommand(explicit, { PATH: 'C:\\nowhere', PATHEXT }), `${explicit}.exe`);
  assert.equal(resolveWindowsCommand(path.join(dir, 'ghost'), { PATH: dir, PATHEXT }), null);
});
