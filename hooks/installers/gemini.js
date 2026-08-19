// Gemini CLI: hooks live in ~/.gemini/settings.json with the same nested
// shape as Claude Code's but its own event vocabulary (the server maps it
// onto the canonical one) and timeout in MILLISECONDS. Gemini requires hook
// stdout to be clean JSON-or-nothing; emit.js never writes to stdout, so the
// relay satisfies that. Only the events the Agents board can use are wired -
// the model/notification chatter stays uninstalled.
import { homedir } from 'node:os';
import path from 'node:path';

export const gemini = {
  id: 'gemini',
  label: 'Gemini CLI',
  kind: 'json',
  defaultSettingsPath: () => path.join(homedir(), '.gemini', 'settings.json'),
  events: ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'SessionEnd'],
  matcherEvents: new Set(), // an absent matcher applies to every tool
  timeout: 5000,
  source: 'gemini-cli',
};
