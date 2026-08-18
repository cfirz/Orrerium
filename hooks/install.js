#!/usr/bin/env node
// Installs the Agents-board hooks into ~/.claude/settings.json: one matcher
// group per event, all seven running hooks/emit.js from this clone. Merges,
// never clobbers - every other setting and every user hook stays untouched,
// and the previous file is backed up beside itself before the first write.
//
//   node hooks/install.js              install (asks before writing on a TTY)
//   node hooks/install.js --dry-run    preview the merge, write nothing
//   node hooks/install.js --uninstall  remove the Orrerium hooks again
//   node hooks/install.js --yes        skip the confirmation (for scripts)
//   node hooks/install.js --settings <path>   target a non-default settings file
//
// Standalone like emit.js - no imports from lib/, runs from any checkout.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'SubagentStop', 'Stop', 'SessionEnd',
];
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

// any command that runs a hooks/emit.js is treated as an Orrerium hook - that
// is how a stale entry from a moved or renamed clone gets found and fixed
const EMIT_RE = /hooks[\\/]emit\.js/i;

const fwd = (p) => p.replaceAll('\\', '/');

// the installed command uses forward slashes even on Windows (node accepts
// them) so the JSON needs no double-backslash escaping and copies across OSes
export const emitCommand = (emitPath) => `node "${fwd(emitPath)}"`;

const referencesEmit = (h) => typeof h?.command === 'string' && EMIT_RE.test(h.command);

function sameEmitPath(command, emitPath) {
  const cmd = fwd(command);
  const p = fwd(emitPath);
  return process.platform === 'win32'
    ? cmd.toLowerCase().includes(p.toLowerCase())
    : cmd.includes(p);
}

function buildGroup(event, command) {
  const hook = { type: 'command', command, timeout: 5 };
  return MATCHER_EVENTS.has(event) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] };
}

// pure: parsed settings in, { settings, changes } out; changes[event] is one
// of added | updated | ok. Throws (before any write) on shapes it cannot merge.
export function applyInstall(settings, emitPath) {
  const out = structuredClone(settings ?? {});
  out.hooks ??= {};
  if (typeof out.hooks !== 'object' || Array.isArray(out.hooks)) {
    throw new Error('"hooks" in the settings file is not an object - fix it by hand first');
  }
  const command = emitCommand(emitPath);
  const changes = {};
  for (const event of EVENTS) {
    const groups = (out.hooks[event] ??= []);
    if (!Array.isArray(groups)) {
      throw new Error(`"hooks.${event}" in the settings file is not an array - fix it by hand first`);
    }
    const ours = groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks.filter(referencesEmit) : []));
    if (ours.length === 0) {
      groups.push(buildGroup(event, command));
      changes[event] = 'added';
      continue;
    }
    let touched = false;
    for (const h of ours) {
      if (!sameEmitPath(h.command, emitPath)) { h.command = command; touched = true; }
      if (h.type !== 'command') { h.type = 'command'; touched = true; }
      if (h.timeout == null) { h.timeout = 5; touched = true; } // an explicit timeout is the user's
    }
    if (ours.length > 1) { // duplicate manual installs collapse to one
      let seen = false;
      for (const g of groups) {
        if (!Array.isArray(g?.hooks)) continue;
        g.hooks = g.hooks.filter((h) => !referencesEmit(h) || (seen ? false : (seen = true)));
      }
      out.hooks[event] = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
      touched = true;
    }
    changes[event] = touched ? 'updated' : 'ok';
  }
  return { settings: out, changes };
}

// pure: removes every Orrerium hook (stale clones included), drops groups and
// event keys that end up empty; changes[event] is removed | none
export function applyUninstall(settings) {
  const out = structuredClone(settings ?? {});
  const changes = {};
  for (const event of EVENTS) {
    const groups = out.hooks?.[event];
    if (!Array.isArray(groups)) { changes[event] = 'none'; continue; }
    let removed = 0;
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) continue;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => !referencesEmit(h));
      removed += before - g.hooks.length;
    }
    out.hooks[event] = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (out.hooks[event].length === 0) delete out.hooks[event];
    changes[event] = removed ? 'removed' : 'none';
  }
  if (out.hooks && Object.keys(out.hooks).length === 0) delete out.hooks;
  return { settings: out, changes };
}

// I/O wrapper around the pure merges. Refuses to touch a file it cannot parse;
// on a real change, copies the old file to a timestamped backup, then writes
// atomically (tmp+rename, same as lib/store.js).
export function install({ settingsPath, emitPath, uninstall = false, dryRun = false }) {
  let current = {};
  const exists = existsSync(settingsPath);
  if (exists) {
    const raw = readFileSync(settingsPath, 'utf8');
    try {
      current = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${settingsPath} is not valid JSON (${err.message}) - nothing was written`);
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error(`${settingsPath} is not a JSON object - nothing was written`);
    }
  }
  const { settings, changes } = uninstall ? applyUninstall(current) : applyInstall(current, emitPath);
  const changed = JSON.stringify(settings) !== JSON.stringify(current);
  let backupPath = null;
  if (changed && !dryRun) {
    if (exists) {
      const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      backupPath = `${settingsPath}.orrerium-backup-${ts}`;
      copyFileSync(settingsPath, backupPath);
    }
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    renameSync(tmp, settingsPath);
  }
  return { changes, changed, backupPath };
}

function flagValue(args, name) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: node hooks/install.js [--dry-run] [--uninstall] [--yes] [--settings <path>]');
    return;
  }
  const uninstall = args.includes('--uninstall');
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes') || args.includes('-y');
  const settingsPath = path.resolve(
    flagValue(args, '--settings') ?? path.join(homedir(), '.claude', 'settings.json'),
  );
  const emitPath = fileURLToPath(new URL('./emit.js', import.meta.url));

  const preview = install({ settingsPath, emitPath, uninstall, dryRun: true });
  console.log(`${uninstall ? 'Removing Orrerium hooks from' : 'Installing Orrerium hooks into'} ${settingsPath}\n`);
  for (const event of EVENTS) console.log(`  ${event.padEnd(18)} ${preview.changes[event]}`);
  console.log('');
  if (!preview.changed) { console.log('Nothing to change.'); return; }
  if (dryRun) { console.log('Dry run - nothing written.'); return; }

  if (!yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error('Not an interactive terminal - re-run with --yes to write.');
      process.exitCode = 1;
      return;
    }
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Write ${settingsPath}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') { console.log('Aborted - nothing written.'); return; }
  }

  const result = install({ settingsPath, emitPath, uninstall });
  if (result.backupPath) console.log(`Previous settings backed up to ${result.backupPath}`);
  console.log(uninstall
    ? 'Hooks removed.'
    : 'Hooks installed. Already-running Claude Code sessions pick them up on their next restart.\n'
      + 'If Orrerium listens on a non-default port, set ORRERIUM_PORT in the environment the hooks run in.');
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
