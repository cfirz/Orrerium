// Claude Code: hooks live in ~/.claude/settings.json as
// hooks.<Event>[] -> { matcher?, hooks: [{ type, command, timeout }] },
// timeout in SECONDS. No --source flag on the command: claude-code is the
// server-side default dialect, so already-installed hooks keep working.
import { homedir } from 'node:os';
import path from 'node:path';

export const claude = {
  id: 'claude',
  label: 'Claude Code',
  kind: 'json',
  defaultSettingsPath: () => path.join(homedir(), '.claude', 'settings.json'),
  events: [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'SubagentStop', 'Stop', 'SessionEnd',
  ],
  matcherEvents: new Set(['PreToolUse', 'PostToolUse']),
  timeout: 5,
  source: null,
};
