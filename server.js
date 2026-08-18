import http from 'node:http';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { loadConfig } from './lib/config.js';
import { serveStatic } from './lib/static.js';
import { parseVault, parseSkills, parseFrontmatter } from './lib/vault.js';
import { buildGraph } from './lib/graph.js';
import { watchVault } from './lib/watch.js';
import { ask, resolveProvider } from './lib/ask.js';
import { sseHandler, broadcast } from './lib/sse.js';
import { scanClaudeAssets, mergeClaudeAssets } from './lib/claude-scan.js';
import { createAgentTracker } from './lib/agents.js';
import { summarize, groupSessions, buildFlow } from './lib/flows.js';
import { buildStats } from './lib/stats.js';
import { readLines, readJson, writeJson } from './lib/store.js';
import { readBody } from './lib/http-body.js';
import { createCronRunner } from './lib/crons.js';
import { createAskHistory } from './lib/ask-history.js';

const config = loadConfig();
const PUBLIC_DIR = path.join(config.root, 'public');
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// --- graph cache: rebuilt eagerly, served from memory ---------------------

let graph = null;
let noteIndex = new Map(); // id -> { path, folder, type }
let corpus = { notes: [], skills: [] }; // parsed content, reused by /api/ask
let claudeAssets = { items: [], warnings: [] }; // cross-repo scan, refreshed on its own cadence
let claudeKey = null;

function rebuild() {
  const parsed = parseVault(config.vaultPath, { excludeDirs: config.excludeDirs, folderTypes: config.folderTypes });
  const { skills, warnings: skillWarnings } = parseSkills(config.vaultPath);
  corpus = { notes: parsed.notes, skills };
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
rebuild();

setInterval(() => {
  if (rescanClaude()) {
    rebuild();
    broadcast('vault', { files: [] });
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
    rebuild(); // rebuild BEFORE notifying so the client refetch never races the parser
    broadcast('vault', { files });
    console.log(`[watch] ${files.join(', ')}`);
  },
});

// --- http -----------------------------------------------------------------

// --- crons: in-process scheduler running `claude -p` headless ---------------

// cron runs impersonate sessions on the agents board/flows via synthetic events
const cronSession = (job, startTs) => `cron-${job.id}-${startTs}`;

const cronRunner = createCronRunner({
  dataDir: config.dataDir,
  ai: config.ai,
  onChange: () => broadcast('crons', { jobs: cronRunner.list() }),
  onRunStart: (job, ts) => {
    agentTracker.record({ ts, hook_event_name: 'SessionStart', session_id: cronSession(job, ts), cwd: job.cwd ?? config.root });
    agentTracker.record({ ts, hook_event_name: 'UserPromptSubmit', session_id: cronSession(job, ts), cwd: job.cwd ?? config.root, prompt: `[cron ${job.name}] ${job.prompt}` });
    broadcast('agents', agentTracker.snapshot());
    console.log(`[crons] ${job.id} started`);
  },
  onRunEnd: (job, record) => {
    agentTracker.record({ ts: record.endedAt, hook_event_name: 'SessionEnd', session_id: cronSession(job, record.startedAt), cwd: job.cwd ?? config.root });
    broadcast('agents', agentTracker.snapshot());
    console.log(`[crons] ${job.id} ${record.status} in ${Math.round(record.ms / 1000)}s`);
  },
});
cronRunner.start();

// --- ask conversation history: saved server-side on every answered turn ----

const askHistory = createAskHistory({ dataDir: config.dataDir });

// --- icon assignments: agent id -> icon name (catalog lives client-side) ---

const ICON_FILE = path.join(config.dataDir, 'icon-assignments.json');
const ICON_NAME_RE = /^[a-z0-9-]{1,32}$/;
let iconAssignments = readJson(ICON_FILE, {});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'POST' && p === '/api/ask') return handleAsk(req, res);
  if (req.method === 'POST' && p === '/api/hook-event') return handleHookEvent(req, res);
  if (req.method === 'POST' && p === '/api/icons/assign') return handleIconAssign(req, res);
  if (req.method === 'POST' && p === '/api/crons') return handleCronUpsert(req, res);
  const cronRun = /^\/api\/crons\/([A-Za-z0-9._-]+)\/run$/.exec(p);
  if (req.method === 'POST' && cronRun) return handleCronRun(cronRun[1], res);
  const cronDel = /^\/api\/crons\/([A-Za-z0-9._-]+)$/.exec(p);
  if (req.method === 'DELETE' && cronDel) {
    cronRunner.remove(cronDel[1]);
    return sendJson(res, 200, { jobs: cronRunner.list() });
  }
  const askHistDel = /^\/api\/ask\/history\/([A-Za-z0-9._-]+)$/.exec(p);
  if (req.method === 'DELETE' && askHistDel) {
    return sendJson(res, 200, { conversations: askHistory.remove(askHistDel[1]) });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }

  if (p === '/api/graph') return sendJson(res, 200, graph);
  if (p === '/api/agents') return sendJson(res, 200, agentTracker.snapshot());
  if (p === '/api/icons') return sendJson(res, 200, { assignments: iconAssignments });
  if (p === '/api/crons') return sendJson(res, 200, { jobs: cronRunner.list() });
  if (p === '/api/ask/history') return sendJson(res, 200, { conversations: askHistory.list() });
  const askHistGet = /^\/api\/ask\/history\/([A-Za-z0-9._-]+)$/.exec(p);
  if (askHistGet) {
    const conversation = askHistory.get(askHistGet[1]);
    if (!conversation) return sendJson(res, 404, { error: `no conversation "${askHistGet[1]}"` });
    return sendJson(res, 200, { conversation });
  }
  const cronRuns = /^\/api\/crons\/([A-Za-z0-9._-]+)\/runs$/.exec(p);
  if (cronRuns) return sendJson(res, 200, { runs: cronRunner.runsFor(cronRuns[1]) });
  if (p === '/api/flows') return sendJson(res, 200, { sessions: summarize(recentAgentEvents()) });
  if (p === '/api/stats') {
    // recomputed per request, like /api/flows - see the note in lib/stats.js
    const jobs = cronRunner.list();
    return sendJson(res, 200, buildStats({
      events: recentAgentEvents(),
      cronJobs: jobs,
      cronRunsByJob: Object.fromEntries(jobs.map((j) => [j.id, cronRunner.runsFor(j.id)])),
      conversations: askHistory.list(),
    }));
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
  serveStatic(PUBLIC_DIR, p, res);
});

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

async function handleAsk(req, res) {
  const body = await readBody(req, res, 64 * 1024);
  if (body === null) return;
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'body must be JSON: {"question": "..."}' });
  }
  const question = payload?.question;
  if (typeof question !== 'string' || !question.trim() || question.length > 4000) {
    return sendJson(res, 400, { error: 'question must be a non-empty string (max 4000 chars)' });
  }
  if (payload?.conversationId != null && !(typeof payload.conversationId === 'string' && SLUG_RE.test(payload.conversationId))) {
    return sendJson(res, 400, { error: 'invalid conversationId' });
  }
  // prior turns from the client, sanitized: role/content pairs only, capped
  const history = (Array.isArray(payload?.history) ? payload.history : [])
    .filter((h) => (h?.role === 'user' || h?.role === 'assistant') && typeof h?.content === 'string' && h.content.length <= 16000)
    .slice(-20);
  const record = (result) => {
    // a disk hiccup must not turn a good answer into an error
    try {
      return askHistory.record({
        id: payload.conversationId, history, question: question.trim(),
        answer: result.answer, provider: result.provider, model: result.model,
      }).id;
    } catch (err) {
      console.error(`[ask] history write failed: ${err.message}`);
      return null;
    }
  };

  if (payload?.stream === true) {
    // NDJSON relay: {type:meta}, {type:delta}* then {type:done} or {type:error}.
    // The status is committed before the provider runs, so provider failures
    // ride an error line, not an HTTP code.
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort(); // client went away - stop the provider
    });
    const line = (obj) => {
      if (!abort.signal.aborted) res.write(`${JSON.stringify(obj)}\n`);
    };
    line({ type: 'meta', provider: resolveProvider(config.ai) });
    try {
      const result = await ask(question.trim(), {
        ...corpus, ai: config.ai, history,
        onDelta: (text) => line({ type: 'delta', text }),
        signal: abort.signal,
      });
      line({ type: 'done', ...result, conversationId: record(result) });
    } catch (err) {
      // an aborted provider call is the client leaving, not an error
      if (!abort.signal.aborted) console.error(`[ask] ${err.message}`);
      line({ type: 'error', error: err.message });
    }
    res.end();
    return;
  }

  try {
    const result = await ask(question.trim(), { ...corpus, ai: config.ai, history });
    sendJson(res, 200, { ...result, conversationId: record(result) });
  } catch (err) {
    console.error(`[ask] ${err.message}`);
    sendJson(res, 502, { error: err.message });
  }
}

// hook payloads can be big (whole tool inputs/responses ride along) - higher
// cap than /api/ask, and the tracker whitelists/truncates before persisting
async function handleHookEvent(req, res) {
  const body = await readBody(req, res, 256 * 1024);
  if (body === null) return;
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'body must be a JSON hook payload' });
  }
  if (!raw || typeof raw !== 'object') return sendJson(res, 400, { error: 'not an object' });
  agentTracker.record(raw);
  broadcast('agents', agentTracker.snapshot());
  res.writeHead(204);
  res.end();
}

async function handleCronUpsert(req, res) {
  const body = await readBody(req, res, 64 * 1024);
  if (body === null) return;
  let def;
  try {
    def = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: 'body must be a JSON cron definition' });
  }
  try {
    const job = cronRunner.upsert(def);
    sendJson(res, 200, { job });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleCronRun(id, res) {
  try {
    const record = await cronRunner.runNow(id);
    sendJson(res, 200, record ? { record } : { alreadyRunning: true });
  } catch (err) {
    sendJson(res, 404, { error: err.message });
  }
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
