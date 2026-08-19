// Shared merge + IO for the per-tool hook installers. The pure JSON merges
// (applyInstall/applyUninstall) are parameterized by a tool descriptor:
//   { events, matcherEvents, timeout, source } - see claude.js / gemini.js.
// Standalone like emit.js - no imports from lib/, runs from any checkout.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// any command that runs a hooks/emit.js is treated as an Orrerium hook - that
// is how a stale entry from a moved or renamed clone gets found and fixed
export const EMIT_RE = /hooks[\\/]emit\.js/i;

export const fwd = (p) => p.replaceAll('\\', '/');

// the installed command uses forward slashes even on Windows (node accepts
// them) so the JSON needs no double-backslash escaping and copies across OSes
export const emitCommand = (emitPath, source) =>
  `node "${fwd(emitPath)}"${source ? ` --source=${source}` : ''}`;

const referencesEmit = (h) => typeof h?.command === 'string' && EMIT_RE.test(h.command);

function sameEmitPath(command, emitPath) {
  const cmd = fwd(command);
  const p = fwd(emitPath);
  return process.platform === 'win32'
    ? cmd.toLowerCase().includes(p.toLowerCase())
    : cmd.includes(p);
}

function buildGroup(event, command, tool) {
  const hook = { type: 'command', command, timeout: tool.timeout };
  return tool.matcherEvents.has(event) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] };
}

// pure: parsed settings in, { settings, changes } out; changes[event] is one
// of added | updated | ok. Throws (before any write) on shapes it cannot merge.
export function applyInstall(settings, emitPath, tool) {
  const out = structuredClone(settings ?? {});
  out.hooks ??= {};
  if (typeof out.hooks !== 'object' || Array.isArray(out.hooks)) {
    throw new Error('"hooks" in the settings file is not an object - fix it by hand first');
  }
  const command = emitCommand(emitPath, tool.source);
  const changes = {};
  for (const event of tool.events) {
    const groups = (out.hooks[event] ??= []);
    if (!Array.isArray(groups)) {
      throw new Error(`"hooks.${event}" in the settings file is not an array - fix it by hand first`);
    }
    const ours = groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks.filter(referencesEmit) : []));
    if (ours.length === 0) {
      groups.push(buildGroup(event, command, tool));
      changes[event] = 'added';
      continue;
    }
    let touched = false;
    for (const h of ours) {
      // repair a moved clone's path, and an entry missing the tool's source tag
      const wrongSource = tool.source ? !h.command.includes(`--source=${tool.source}`) : false;
      if (!sameEmitPath(h.command, emitPath) || wrongSource) { h.command = command; touched = true; }
      if (h.type !== 'command') { h.type = 'command'; touched = true; }
      if (h.timeout == null) { h.timeout = tool.timeout; touched = true; } // an explicit timeout is the user's
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

// pure: removes every Orrerium hook (stale clones included) from the tool's
// events plus any other event key one leaked into; drops groups and event
// keys that end up empty; changes[event] is removed | none
export function applyUninstall(settings, tool) {
  const out = structuredClone(settings ?? {});
  const changes = {};
  const events = [...new Set([...tool.events, ...Object.keys(out.hooks ?? {})])];
  for (const event of events) {
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

// on a real change: timestamped backup beside the file, then atomic tmp+rename
export function backupAndWrite(settingsPath, exists, content) {
  let backupPath = null;
  if (exists) {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    backupPath = `${settingsPath}.orrerium-backup-${ts}`;
    copyFileSync(settingsPath, backupPath);
  }
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, settingsPath);
  return backupPath;
}

// I/O wrapper around the pure JSON merges. Refuses a file it cannot parse.
export function installJson({ settingsPath, emitPath, tool, uninstall = false, dryRun = false }) {
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
  const { settings, changes } = uninstall
    ? applyUninstall(current, tool)
    : applyInstall(current, emitPath, tool);
  const changed = JSON.stringify(settings) !== JSON.stringify(current);
  let backupPath = null;
  if (changed && !dryRun) {
    backupPath = backupAndWrite(settingsPath, exists, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { changes, changed, backupPath };
}
