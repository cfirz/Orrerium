// Pure vault parser: scan a markdown vault -> notes[] with frontmatter and links.
// No http, no fs.watch - this module is the reusable, agent-facing core.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WIKILINK_RE = /\[\[([^\]|#]+)\]\]/g;
// relative .md links like [x](projects/orbit-tracker.md) - used by the vault's root docs
const MDLINK_RE = /\]\((?!https?:\/\/)([^)#\s]+\.md)\)/g;

const FOLDER_TYPE = {
  projects: 'project',
  lessons: 'lesson',
  machine: 'machine',
  ideas: 'idea',
  templates: 'template',
};

export function parseVault(vaultPath, opts = {}) {
  const excludeDirs = new Set(opts.excludeDirs ?? ['.obsidian', '.claude', '.git']);
  const notes = [];
  const warnings = [];
  for (const relPath of listMarkdownFiles(vaultPath, excludeDirs)) {
    try {
      notes.push(parseNote(vaultPath, relPath));
    } catch (err) {
      // a file mid-write may fail to read; the next watch event heals it
      warnings.push(`failed to parse ${relPath}: ${err.message}`);
    }
  }
  return { notes, warnings };
}

function* listMarkdownFiles(root, excludeDirs, rel = '') {
  const entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!excludeDirs.has(entry.name)) yield* listMarkdownFiles(root, excludeDirs, relPath);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      yield relPath;
    }
  }
}

export function parseNote(vaultPath, relPath) {
  const text = readFileSync(path.join(vaultPath, relPath), 'utf8');
  const { fields, markdown } = parseFrontmatter(text);
  const stem = path.basename(relPath, '.md');
  const folder = relPath.includes('/') ? relPath.split('/')[0] : null;
  const stripped = stripCode(markdown);
  return {
    id: stem,
    path: relPath,
    folder,
    type: typeOf(fields, folder),
    name: str(fields.name) ?? stem,
    description: str(fields.description),
    tags: list(fields.tags),
    updated: str(fields.updated),
    status: str(fields.status),
    dir: str(fields.dir),
    projectLinks: list(fields.projects).flatMap(extractWikilinks),
    bodyLinks: extractWikilinks(stripped),
    // markdown links (root docs) may point at excluded files; they only become
    // edges when the target resolves to a note - never ghosts
    docLinks: extractMarkdownLinks(stripped),
    rawBody: markdown, // kept for mention scans (skill paths live in code spans)
  };
}

// .claude/skills/*/SKILL.md -> routine nodes. A different frontmatter dialect
// (unquoted multi-line description), scanned explicitly - excludeDirs keeps
// these out of the regular note walk.
export function parseSkills(vaultPath) {
  const skillsDir = path.join(vaultPath, '.claude', 'skills');
  const skills = [];
  const warnings = [];
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return { skills, warnings }; // vault has no skills - fine
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relPath = `.claude/skills/${entry.name}/SKILL.md`;
    try {
      const text = readFileSync(path.join(vaultPath, relPath), 'utf8');
      const { fields, markdown } = parseFrontmatter(text);
      const stripped = stripCode(markdown);
      skills.push({
        id: str(fields.name) ?? entry.name,
        path: relPath,
        folder: '.claude/skills',
        type: 'routine',
        name: str(fields.name) ?? entry.name,
        description: str(fields.description),
        tags: [],
        updated: null,
        status: null,
        dir: null,
        projectLinks: [],
        bodyLinks: extractWikilinks(stripped),
        docLinks: extractMarkdownLinks(stripped),
        rawBody: markdown,
      });
    } catch (err) {
      warnings.push(`failed to parse ${relPath}: ${err.message}`);
    }
  }
  return { skills, warnings };
}

// --- frontmatter ---------------------------------------------------------
// Hand-rolled for this vault's dialect (CONVENTIONS.md): flat key: value pairs,
// double-quoted single-line strings, inline flow lists, no multi-line scalars.

export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0] ?? '')) return { fields: {}, markdown: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) return { fields: {}, markdown: text };
  const fields = {};
  let lastKey = null;
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i]);
    if (m) {
      fields[m[1]] = parseValue(m[2]);
      lastKey = m[1];
    } else if (lastKey && /^\s+\S/.test(lines[i]) && typeof fields[lastKey] === 'string') {
      // indented continuation of a plain multi-line value (skill manifests use these)
      fields[lastKey] = `${fields[lastKey]} ${lines[i].trim()}`.trim();
    }
  }
  return { fields, markdown: lines.slice(end + 1).join('\n') };
}

function parseValue(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v.startsWith('"')) return parseQuoted(v);
  if (v.startsWith('[')) return parseFlowList(v);
  return stripInlineComment(v).trim();
}

function parseQuoted(v) {
  let out = '';
  for (let i = 1; i < v.length; i++) {
    const c = v[i];
    if (c === '\\' && v[i + 1] === '"') { out += '"'; i++; }
    else if (c === '"') return out;
    else out += c;
  }
  return out; // unterminated - take what we have rather than throw
}

function parseFlowList(v) {
  const close = v.lastIndexOf(']');
  const inner = v.slice(1, close === -1 ? v.length : close);
  const items = [];
  let cur = '';
  let inQuote = false;
  for (const c of inner) {
    if (c === '"') { inQuote = !inQuote; cur += c; }
    else if (c === ',' && !inQuote) { items.push(cur); cur = ''; }
    else cur += c;
  }
  items.push(cur);
  return items
    .map((s) => {
      s = s.trim();
      if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
      return s;
    })
    .filter((s) => s !== '');
}

// templates carry trailing comments: `type: template   # set to: project`
function stripInlineComment(v) {
  const idx = v.search(/\s#/);
  return idx === -1 ? v : v.slice(0, idx);
}

// --- links ---------------------------------------------------------------

// remove fenced blocks (dataview queries live in them) and inline code
export function stripCode(body) {
  return body.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

export function extractWikilinks(text) {
  const out = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const slug = m[1].trim();
    if (slug) out.push(slug);
  }
  return out;
}

// returns vault-root-normalized target paths ("projects/orbit-tracker.md"); the graph
// builder resolves them by path first, then by basename stem
export function extractMarkdownLinks(text) {
  const out = [];
  for (const m of text.matchAll(MDLINK_RE)) {
    out.push(normalizeLinkPath(m[1].trim()));
  }
  return out;
}

export function normalizeLinkPath(target) {
  return target
    .replaceAll('\\', '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
    .join('/');
}

// --- helpers -------------------------------------------------------------

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function list(v) {
  return Array.isArray(v) ? v : [];
}

function typeOf(fields, folder) {
  const t = str(fields.type);
  if (t) return t;
  return folder ? (FOLDER_TYPE[folder] ?? 'root') : 'root';
}
