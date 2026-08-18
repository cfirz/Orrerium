// Spawning the `claude` CLI without a shell.
//
// `shell: true` was here to resolve Windows `claude.cmd` shims, but it makes
// Node concatenate argv into a command line instead of escaping it (Node 22
// deprecates the combination, DEP0190) - anything user-controlled reaching
// argv or the command name would be shell syntax. So we do the PATH lookup
// ourselves and hand spawn a concrete executable.
//
// Windows resolution follows cmd.exe: directory-major, PATHEXT-minor, which
// already prefers claude.exe over claude.cmd inside the same directory. Only
// a batch shim (.cmd/.bat) still needs cmd.exe, and there we build the command
// line ourselves - the shim path is double-quoted, which neutralises every cmd
// metacharacter, and the rest of argv is ours.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const BATCH = new Set(['.cmd', '.bat']);

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// cmd.exe matches file names case-insensitively. On Windows a plain stat
// already behaves that way; on the case-sensitive hosts that run these
// win32 code paths in tests (Linux CI), the PATHEXT spelling can miss a
// file Windows would find, so fall back to a directory-listing match there.
const findFile =
  process.platform === 'win32'
    ? (p) => (isFile(p) ? p : null)
    : (p) => {
        if (isFile(p)) return p;
        let names;
        try {
          names = readdirSync(path.dirname(p));
        } catch {
          return null;
        }
        const want = path.basename(p).toLowerCase();
        const hit = names.find((n) => n.toLowerCase() === want);
        if (hit === undefined) return null;
        const full = path.join(path.dirname(p), hit);
        return isFile(full) ? full : null;
      };

// cmd.exe's own search: for each PATH entry, the bare name then each PATHEXT.
// Windows semantics throughout regardless of host - `;` PATH delimiter, both
// slashes as separators - so the emulation holds when tests run on POSIX.
export function resolveWindowsCommand(command, env = process.env) {
  const exts = (env.PATHEXT || DEFAULT_PATHEXT).split(';').filter(Boolean);
  const lower = command.toLowerCase();
  const hasKnownExt = exts.some((e) => lower.endsWith(e.toLowerCase()));

  const tryPath = (base) => {
    if (hasKnownExt) {
      const hit = findFile(base);
      if (hit) return hit;
    }
    for (const ext of exts) {
      const hit = findFile(base + ext);
      if (hit) return hit;
    }
    return null;
  };

  // an explicit path is used as given, never searched for on PATH
  if (command.includes('/') || command.includes('\\') || path.win32.isAbsolute(command)) {
    return tryPath(command);
  }

  for (const dir of (env.PATH || env.Path || '').split(';').filter(Boolean)) {
    const hit = tryPath(path.join(dir.replace(/^"|"$/g, ''), command));
    if (hit) return hit;
  }
  return null;
}

// -> { file, args, options } to pass straight to child_process.spawn
export function resolveCliInvocation(command, args, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { file: command, args, options: {} };

  const resolved = resolveWindowsCommand(command, env);
  // unresolved: spawn the bare name and let ENOENT produce the usual "install
  // the Claude CLI" message rather than silently falling back to a shell
  if (!resolved) return { file: command, args, options: {} };
  if (!BATCH.has(path.extname(resolved).toLowerCase())) {
    return { file: resolved, args, options: {} };
  }

  // cmd.exe /d /s /c "<line>" - /s strips exactly the outer pair of quotes
  const line = [quoteForCmd(resolved), ...args.map(quoteForCmd)].join(' ');
  return {
    file: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

// Windows paths cannot contain `"`, so quoting is all that is needed to keep
// cmd from seeing metacharacters; plain flags are left bare so the child sees
// the argv it would from any other caller.
function quoteForCmd(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_.=:/-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '')}"`;
}
