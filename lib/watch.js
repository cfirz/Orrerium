// Debounced recursive vault watcher. win32 fs.watch quirks handled here:
// duplicate change events per save, renames arriving as two events, editor
// temp-file churn - all coalesced by the trailing debounce + md/exclude filter.
import { watch } from 'node:fs';

export function watchVault(vaultPath, { excludeDirs = [], allowPrefixes = ['.claude/skills/'], debounceMs = 300, onChange }) {
  const excluded = new Set(excludeDirs);
  let timer = null;
  let pending = new Set();

  const watcher = watch(vaultPath, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    const rel = filename.replaceAll('\\', '/'); // fs.watch emits backslashes on win32
    if (!rel.toLowerCase().endsWith('.md')) return;
    const allowed = allowPrefixes.some((p) => rel.startsWith(p)); // skills live under an excluded dir
    if (!allowed && rel.split('/').some((seg) => excluded.has(seg))) return;
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pending];
      pending = new Set();
      onChange(files);
    }, debounceMs);
  });

  // an fs.watch 'error' with no listener is an uncaught exception - the vault
  // folder being deleted or its drive unplugged would take the server down
  watcher.on('error', (err) => {
    console.error(`[watch] ${err.message} - live reload stopped; restart Orrerium to resume`);
  });

  return watcher; // caller may .close()
}
