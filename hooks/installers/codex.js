// Codex CLI: one top-level `notify` argv array in ~/.codex/config.toml, fired
// only on agent-turn-complete - the board gets honest coarse turn cards, not
// live activity. The TOML edit is deliberately line-based and conservative:
// it appends or rewrites only a notify line it owns (EMIT_RE) in the
// top-level block, and refuses a foreign notify with manual instructions -
// Codex supports exactly one notify program, and clobbering the user's is
// worse than asking them to wire it by hand.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { EMIT_RE, backupAndWrite, fwd } from './shared.js';

export const codex = {
  id: 'codex',
  label: 'Codex CLI',
  kind: 'toml',
  defaultSettingsPath: () => path.join(homedir(), '.codex', 'config.toml'),
  events: ['notify'],
  source: 'codex',
};

export const notifyLine = (emitPath) =>
  `notify = ["node", "${fwd(emitPath)}", "--source=codex"]`;

// pure text transform; change is added | updated | ok | removed | none
export function applyCodexToml(text, emitPath, { uninstall = false } = {}) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const desired = notifyLine(emitPath);
  // notify is a top-level key: only lines before the first [section] count
  let sectionStart = lines.findIndex((l) => /^\s*\[/.test(l));
  if (sectionStart === -1) sectionStart = lines.length;
  const idx = lines.findIndex((l, i) => i < sectionStart && /^\s*notify\s*=/.test(l));

  if (uninstall) {
    if (idx === -1 || !EMIT_RE.test(lines[idx])) return { text, change: 'none' };
    lines.splice(idx, 1);
    return { text: lines.join(nl), change: 'removed' };
  }
  if (idx >= 0 && !EMIT_RE.test(lines[idx])) {
    throw new Error(
      'config.toml already sets notify to another program and Codex supports exactly one - '
      + `nothing was written. To switch by hand, replace that line with: ${desired}`,
    );
  }
  if (idx === -1) {
    if (sectionStart < lines.length) {
      lines.splice(sectionStart, 0, desired, '');
    } else {
      while (lines.length && lines.at(-1) === '') lines.pop();
      lines.push(desired, ''); // ends the file with exactly one newline
    }
    return { text: lines.join(nl), change: 'added' };
  }
  if (lines[idx].trim() === desired) return { text, change: 'ok' };
  lines[idx] = desired; // a stale clone path (or old flagless form) rewritten
  return { text: lines.join(nl), change: 'updated' };
}

// I/O wrapper matching installJson's return shape
export function installToml({ settingsPath, emitPath, uninstall = false, dryRun = false }) {
  const exists = existsSync(settingsPath);
  const current = exists ? readFileSync(settingsPath, 'utf8') : '';
  const { text, change } = applyCodexToml(current, emitPath, { uninstall });
  const changed = text !== current;
  let backupPath = null;
  if (changed && !dryRun) backupPath = backupAndWrite(settingsPath, exists, text);
  return { changes: { notify: change }, changed, backupPath };
}
