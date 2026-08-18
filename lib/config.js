import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FOLDER_TYPES } from './vault.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DEFAULTS = {
  // the bundled demo vault; point ORRERIUM_VAULT or config.json at your own
  vaultPath: 'starter-vault',
  host: '127.0.0.1',
  port: 4321,
  excludeDirs: ['.obsidian', '.claude', '.git'],
  // tags in this list become APPLICATION nodes on the outer ring
  applicationTags: ['unity', 'python', 'android', 'windows', 'obsidian', 'git'],
  // folder name -> note type, for vaults with different conventions; a
  // provided map replaces this default wholesale (like excludeDirs)
  folderTypes: { ...DEFAULT_FOLDER_TYPES },
  // ask-your-brain panel. provider: "auto" uses the Claude API when
  // ANTHROPIC_API_KEY is set, else the local `claude` CLI (Claude Code login).
  ai: {
    provider: 'auto',
    model: 'claude-opus-5',
    cliCommand: 'claude',
    timeoutMs: 180_000,
    // ask context budget: vaults estimated under this ship whole (and cache);
    // over it a retrieval step selects the notes that fit
    maxContextTokens: 120_000,
  },
  // cross-repo .claude/{skills,agents,commands} scan; roots are scanned one
  // level deep (each child dir is a candidate repo)
  claudeScan: {
    roots: [],
    globalDir: path.join(os.homedir(), '.claude'),
    settingsPath: path.join(os.homedir(), '.claude', 'settings.json'),
    rescanMs: 300_000,
  },
};

// pure merge + validation, split from loadConfig so tests never have to read
// a real config.json or stat a vault directory
export function mergeConfig(raw = {}) {
  const config = {
    ...DEFAULTS,
    ...raw,
    ai: { ...DEFAULTS.ai, ...raw.ai },
    claudeScan: { ...DEFAULTS.claudeScan, ...raw.claudeScan },
    root: ROOT,
  };
  const valid = new Set(Object.values(DEFAULT_FOLDER_TYPES));
  if (typeof config.folderTypes !== 'object' || config.folderTypes === null || Array.isArray(config.folderTypes)) {
    throw new Error('config.json folderTypes must be an object mapping folder names to note types');
  }
  for (const [folder, type] of Object.entries(config.folderTypes)) {
    if (!valid.has(type)) {
      throw new Error(
        `config.json folderTypes["${folder}"] is "${type}" — valid types are: ${[...valid].join(', ')}`,
      );
    }
  }
  return config;
}

export function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  let raw = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`config.json is not valid JSON: ${err.message}`);
    }
  }
  const config = mergeConfig(raw);
  if (process.env.ORRERIUM_VAULT) config.vaultPath = process.env.ORRERIUM_VAULT;
  config.dataDir = path.join(ROOT, 'data'); // Orrerium-owned writable state; the vault stays read-only
  config.vaultPath = path.resolve(ROOT, config.vaultPath);
  if (!existsSync(config.vaultPath) || !statSync(config.vaultPath).isDirectory()) {
    throw new Error(
      `vaultPath is not a directory: ${config.vaultPath}\n` +
      'Set it via the ORRERIUM_VAULT environment variable, "vaultPath" in config.json ' +
      '(copy config.example.json), or leave both unset to use the bundled starter-vault/.'
    );
  }
  return config;
}
