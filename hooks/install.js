#!/usr/bin/env node
// Installs the Agents-board hooks for a coding-agent CLI. The default tool is
// Claude Code (~/.claude/settings.json, all seven events); --tool gemini
// targets Gemini CLI (~/.gemini/settings.json, its hook vocabulary) and
// --tool codex targets Codex CLI (~/.codex/config.toml, the single notify
// program). Merges, never clobbers - every other setting and every user hook
// stays untouched, and the previous file is backed up beside itself before
// the first write.
//
//   node hooks/install.js                      install for Claude Code (asks on a TTY)
//   node hooks/install.js --tool gemini        install for Gemini CLI
//   node hooks/install.js --tool codex         install for Codex CLI
//   node hooks/install.js --dry-run            preview the merge, write nothing
//   node hooks/install.js --uninstall          remove the Orrerium hooks again
//   node hooks/install.js --yes                skip the confirmation (for scripts)
//   node hooks/install.js --print              print the config snippet for manual wiring
//   node hooks/install.js --settings <path>    target a non-default settings file
//
// Standalone like emit.js - no imports from lib/, runs from any checkout.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyInstall as applyInstallFor,
  applyUninstall as applyUninstallFor,
  emitCommand as emitCommandFor,
  installJson,
} from './installers/shared.js';
import { claude } from './installers/claude.js';
import { gemini } from './installers/gemini.js';
import { codex, installToml, notifyLine } from './installers/codex.js';

const TOOLS = { claude, gemini, codex };

// --- pre-0.3 single-tool API, bound to claude, kept for callers and tests --
export const EVENTS = claude.events;
export const emitCommand = (emitPath) => emitCommandFor(emitPath);
export const applyInstall = (settings, emitPath) => applyInstallFor(settings, emitPath, claude);
export const applyUninstall = (settings) => applyUninstallFor(settings, claude);
export const install = ({ settingsPath, emitPath, uninstall = false, dryRun = false }) =>
  installJson({ settingsPath, emitPath, tool: claude, uninstall, dryRun });

function flagValue(args, name) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

// the honest fallback for every tool, and the docs for wiring by hand
function printSnippet(tool, emitPath) {
  if (tool.kind === 'toml') {
    console.log(`# add at the top level of ${tool.defaultSettingsPath()}`);
    console.log(notifyLine(emitPath));
    return;
  }
  const { settings } = applyInstallFor({}, emitPath, tool);
  console.log(`// merge into ${tool.defaultSettingsPath()}`);
  console.log(JSON.stringify(settings, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: node hooks/install.js [--tool claude|gemini|codex] [--dry-run] [--uninstall] [--yes] [--print] [--settings <path>]');
    return;
  }
  const toolId = flagValue(args, '--tool') ?? 'claude';
  const tool = TOOLS[toolId];
  if (!tool) {
    console.error(`unknown --tool "${toolId}" - expected claude, gemini, or codex`);
    process.exitCode = 1;
    return;
  }
  const uninstall = args.includes('--uninstall');
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes') || args.includes('-y');
  const settingsPath = path.resolve(flagValue(args, '--settings') ?? tool.defaultSettingsPath());
  const emitPath = fileURLToPath(new URL('./emit.js', import.meta.url));

  if (args.includes('--print')) return printSnippet(tool, emitPath);

  const run = (opts) => (tool.kind === 'toml'
    ? installToml({ settingsPath, emitPath, ...opts })
    : installJson({ settingsPath, emitPath, tool, ...opts }));

  const preview = run({ uninstall, dryRun: true });
  console.log(`${uninstall ? 'Removing' : 'Installing'} Orrerium ${tool.label} hooks ${uninstall ? 'from' : 'into'} ${settingsPath}\n`);
  for (const [key, change] of Object.entries(preview.changes)) console.log(`  ${key.padEnd(18)} ${change}`);
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

  const result = run({ uninstall });
  if (result.backupPath) console.log(`Previous settings backed up to ${result.backupPath}`);
  console.log(uninstall
    ? 'Hooks removed.'
    : `Hooks installed. Already-running ${tool.label} sessions pick them up on their next restart.\n`
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
