import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DEFAULTS = {
  // the bundled demo vault; point ORRERIUM_VAULT or config.json at your own
  vaultPath: 'starter-vault',
  host: '127.0.0.1',
  port: 4321,
  excludeDirs: ['.obsidian', '.claude', '.git'],
  // tags in this list become APPLICATION nodes on the outer ring
  applicationTags: ['unity', 'python', 'android', 'windows', 'obsidian', 'git'],
  // ask-your-brain panel. provider: anthropic | openai | gemini | grok |
  // ollama | cli, or "auto" to pick the first provider whose API key is set
  // (ANTHROPIC_API_KEY, then OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY),
  // falling back to the local `claude` CLI (Claude Code login). model defaults
  // per provider (lib/ask.js PROVIDERS); baseUrl overrides the endpoint base
  // (Ollama port, LM Studio, proxies); keyEnv names an alternate env var
  // holding the key - key values themselves are never read from disk.
  ai: {
    provider: 'auto',
    model: null,
    baseUrl: null,
    keyEnv: null,
    cliCommand: 'claude',
    timeoutMs: 180_000,
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
  const config = {
    ...DEFAULTS,
    ...raw,
    ai: { ...DEFAULTS.ai, ...raw.ai },
    claudeScan: { ...DEFAULTS.claudeScan, ...raw.claudeScan },
    root: ROOT,
  };
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
