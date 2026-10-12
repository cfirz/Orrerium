import http from 'node:http';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { loadConfig } from './lib/config.js';
import { serveStatic } from './lib/static.js';
import { parseVault, parseSkills, parseFrontmatter } from './lib/vault.js';
import { buildGraph } from './lib/graph.js';
import { watchVault } from './lib/watch.js';
import { sseHandler, broadcast } from './lib/sse.js';
import { scanClaudeAssets, mergeClaudeAssets } from './lib/claude-scan.js';
import { createAgentTracker } from './lib/agents.js';
import { summarize, groupSessions, buildFlow } from './lib/flows.js';
import { buildStats } from './lib/stats.js';
import { readLines, readJson, writeJson } from './lib/store.js';
import { readBody } from './lib/http-body.js';
import { checkRequest } from './lib/request-guard.js';

const config = loadConfig();
const PUBLIC_DIR = path.join(config.root, 'public');
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// --- graph cache: rebuilt eagerly, served from memory ---------------------

let graph = null;
let noteIndex = new Map(); // id -> { path, folder, type }
let claudeAssets = { items: [], warnings: [] }; // cross-repo scan, refreshed on its own cadence
let claudeKey = null;

function rebuild() {
  const parsed = parseVault(config.vaultPath, { excludeDirs: config.excludeDirs, folderTypes: config.folderTypes });
  const { skills, warnings: skillWarnings } = parseSkills(config.vaultPath);
  graph = {
    generatedAt: new Date().toISOString(),
    vaultPath: config.vaultPath.replaceAll('\\', '/'),
    ...buildGraph(
      { notes: parsed.notes, skills, warnings: [...parsed.warnings, ...skillWarnings] },
      { applicationTags: config.applicationTags },
    ),
  };
  mergeClaudeAssets(graph, claudeAssets.items);
  graph.warnings.push(...claudeAssets.warnings);
  noteIndex = new Map(
    [...parsed.notes, ...skills].map((n) => [n.id, { path: n.path, folder: n.folder, type: n.type }]),
  );
  // scanned items carry absolute paths; serveNote reads them directly
  for (const it of claudeAssets.items) {
    noteIndex.set(it.id, { path: it.path, folder: it.scope === 'global' ? 'global' : it.repo, type: it.type });
  }
  for (const w of graph.warnings) console.warn(`[vault] ${w}`);
}

// external repos change rarely; a periodic rescan beats 26 recursive watchers
function rescanClaude() {
  const next = scanClaudeAssets({ ...config.claudeScan, skipDirs: [config.vaultPath, config.root] });
  const key = JSON.stringify(next.items);
  if (key === claudeKey) return false;
  claudeKey = key;
  claudeAssets = next;
  return true;
}

rescanClaude();
rebuild(); // a broken vault at startup should fail loudly, so unguarded here

// later rebuilds run from timers, where a throw kills the process: a folder
// vanishing mid-walk or the vault drive going away keeps the last good graph
function safeRebuild() {
  try {
    rebuild();
    return true;
  } catch (err) {
    console.error(`[vault] rebuild failed, keeping the last graph: ${err.message}`);
    return false;
  }
}

setInterval(() => {
  try {
    if (rescanClaude() && safeRebuild()) broadcast('vault', { files: [] });
  } catch (err) {
    console.error(`[claude-scan] rescan failed: ${err.message}`);
  }
}, config.claudeScan.rescanMs).unref();

// --- agents live board: hook events in, snapshots out ---------------------

const agentTracker = createAgentTracker({ dataDir: config.dataDir });
{
  const replayed = agentTracker.replayToday();
  if (replayed) console.log(`[agents] replayed ${replayed} events from today's log`);
}

// flows read the same NDJSON log the tracker writes, a fortnight back
const FLOW_DAYS = 14;

function recentAgentEvents() {
  const dir = path.join(config.dataDir, 'agent-events');
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort().slice(-FLOW_DAYS);
  } catch {
    return []; // no events logged yet
  }
  return files.flatMap((f) => readLines(path.join(dir, f)));
}

// --- live reload: fs.watch -> eager rebuild -> SSE ------------------------

watchVault(config.vaultPath, {
  excludeDirs: config.excludeDirs,
  onChange: (files) => {
    // rebuild BEFORE notifying so the client refetch never races the parser
    if (!safeRebuild()) return;
    broadcast('vault', { files });
    console.log(`[watch] ${files.join(', ')}`);
  },
});

// --- icon assignments: agent id -> icon name (catalog lives client-side) ---

const ICON_FILE = path.join(config.dataDir, 'icon-assignments.json');
const ICON_NAME_RE = /^[a-z0-9-]{1,32}$/;
let iconAssignments = readJson(ICON_FILE, {});

const server = http.createServer((req, res) => {
  const refused = checkRequest(req, config);
  if (refused) return sendJson(res, refused.status, { error: refused.error });
  // one bad request answers 500 instead of taking the server down with it -
  // the sync routes throw into the promise, the async handlers reject into it
  Promise.resolve()
    .then(() => route(req, res))
    .catch((err) => {
      console.error(`[http] ${req.method} ${req.url}: ${err.stack ?? err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    });
});

function route(req, res) {
  // a fixed base: only the path and query matter, and the Host header is
  // client input (already pinned by the guard on a loopback listener)
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'POST' && p === '/api/hook-event') return handleHookEvent(req, res, url.searchParams.get('source'));
  if (req.method === 'POST' && p === '/api/icons/assign') return handleIconAssign(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  if (p === '/api/graph') return sendJson(res, 200, graph);
  if (p === '/api/agents') return sendJson(res, 200, agentTracker.snapshot());
  if (p === '/api/icons') return sendJson(res, 200, { assignments: iconAssignments });
  if (p === '/api/flows') return sendJson(res, 200, { sessions: summarize(recentAgentEvents()) });
  if (p === '/api/stats') {
    // recomputed per request, like /api/flows - see the note in lib/stats.js
    return sendJson(res, 200, buildStats({ events: recentAgentEvents() }));
  }
  if (p.startsWith('/api/flows/')) {
    let sessionId;
    try {
      sessionId = decodeURIComponent(p.slice('/api/flows/'.length));
    } catch {
      return sendJson(res, 400, { error: 'bad session id encoding' });
    }
    if (!SLUG_RE.test(sessionId)) return sendJson(res, 400, { error: 'invalid session id' });
    const events = groupSessions(recentAgentEvents()).get(sessionId);
    if (!events) return sendJson(res, 404, { error: `no session "${sessionId}" in the log` });
    return sendJson(res, 200, { sessionId, flow: buildFlow(events) });
  }
  if (p === '/events') return sseHandler(req, res);
  if (p.startsWith('/api/note/')) {
    let slug;
    try {
      slug = decodeURIComponent(p.slice('/api/note/'.length));
    } catch {
      return sendJson(res, 400, { error: 'bad slug encoding' });
    }
    return serveNote(slug, res);
  }
  return serveStatic(PUBLIC_DIR, p, res);
}

function serveNote(slug, res) {
  if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: 'invalid slug' });
  const meta = noteIndex.get(slug); // client never supplies a path
  if (!meta) return sendJson(res, 404, { error: `no note named "${slug}"` });
  let text;
  try {
    // vault notes are vault-relative; scanned claude assets carry absolute paths
    const file = path.isAbsolute(meta.path) ? meta.path : path.join(config.vaultPath, meta.path);
    text = readFileSync(file, 'utf8'); // fresh read
  } catch {
    return sendJson(res, 404, { error: `note file missing: ${meta.path}` });
  }
  const { fields, markdown } = parseFrontmatter(text);
  sendJson(res, 200, {
    id: slug, path: meta.path, folder: meta.folder, type: meta.type,
    frontmatter: fields, markdown,
  });
}

// hook payloads can be big (whole tool inputs/responses ride along) - the
// highest body cap here, and the tracker whitelists/truncates before persisting.
// ?source= names the wire dialect (claude-code when absent, so every already
// installed hook keeps working); any other well-formed slug is accepted and
// read as the normalized generic shape - that is the open ingest contract.
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

async function handleHookEvent(req, res, source) {
  if (source != null && !SOURCE_RE.test(source)) {
    return sendJson(res, 400, { error: 'source must be a lowercase [a-z0-9-] slug, max 32 chars' });
  }
  const body = await readBody(req, res, 256 * 1024);
  if (body === null) return;
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'body must be a JSON hook payload' });
  }
  if (!raw || typeof raw !== 'object') return sendJson(res, 400, { error: 'not an object' });
  agentTracker.record(raw, source ?? undefined);
  broadcast('agents', agentTracker.snapshot());
  res.writeHead(204);
  res.end();
}

async function handleIconAssign(req, res) {
  const body = await readBody(req, res, 4 * 1024);
  if (body === null) return;
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'body must be JSON: {"agent": "...", "icon": "..." | null}' });
  }
  const { agent, icon } = payload ?? {};
  if (typeof agent !== 'string' || !SLUG_RE.test(agent)) {
    return sendJson(res, 400, { error: 'agent must be a node id' });
  }
  if (icon !== null && (typeof icon !== 'string' || !ICON_NAME_RE.test(icon))) {
    return sendJson(res, 400, { error: 'icon must be a catalog name or null' });
  }
  if (icon === null) delete iconAssignments[agent];
  else iconAssignments[agent] = icon;
  writeJson(ICON_FILE, iconAssignments);
  broadcast('icons', { assignments: iconAssignments });
  sendJson(res, 200, { assignments: iconAssignments });
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use - change "port" in config.json or stop the other process.`);
    process.exit(1);
  }
  throw err;
});

server.listen(config.port, config.host, () => {
  console.log(`Orrerium listening on http://${config.host}:${config.port}  (vault: ${config.vaultPath})`);
});
