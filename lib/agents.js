// Live agent-session state derived from coding-agent hook events. Events
// arrive in per-tool wire dialects (Claude Code hooks, Gemini CLI hooks,
// Codex notify, the cron runner, or the already-normalized generic shape) and
// a per-source adapter translates each into one canonical event vocabulary.
// Pure derivation (sanitizeEvents/applyEvent) wrapped by a tracker that owns
// NDJSON persistence under data/agent-events/. No http, no timers - staleness
// is computed on read.
import path from 'node:path';
import { appendLine, readLines } from './store.js';

const DEFAULT_STALE_MS = 90_000;

export const DEFAULT_SOURCE = 'claude-code';

// The subagent-spawning tool is `Agent`; older Claude Code builds called it
// `Task` and log days from back then still hold those events, so match both.
export function isSubagentTool(tool) {
  return tool === 'Agent' || tool === 'Task';
}

// whitelist + truncate: hook payloads carry whole tool inputs/responses,
// which can be huge; the log keeps only what the board and flows need
function pickInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = {};
  for (const key of ['subagent_type', 'description', 'command', 'file_path', 'pattern', 'url']) {
    const v = str(toolInput[key]);
    if (v) input[key] = trunc(v, 200);
  }
  return Object.keys(input).length ? input : null;
}

// Claude Code's hook payload: snake_case fields, PascalCase event names -
// which is also the canonical vocabulary everything downstream speaks
function claudeEvent(raw) {
  return {
    ts: raw.ts,
    event: str(raw.hook_event_name) ?? 'unknown',
    sessionId: str(raw.session_id),
    cwd: str(raw.cwd),
    tool: str(raw.tool_name),
    prompt: str(raw.prompt),
    input: pickInput(raw.tool_input),
    isError: isErrorResponse(raw.tool_response),
  };
}

// Gemini CLI hooks use the same field names as Claude Code but their own
// event vocabulary; unmapped events (BeforeModel, Notification, ...) fall
// through as "unknown" and applyEvent ignores them
const GEMINI_EVENTS = {
  SessionStart: 'SessionStart',
  BeforeAgent: 'UserPromptSubmit',
  BeforeTool: 'PreToolUse',
  AfterTool: 'PostToolUse',
  AfterAgent: 'Stop',
  SessionEnd: 'SessionEnd',
};

function geminiEvent(raw) {
  const evt = claudeEvent(raw);
  evt.event = GEMINI_EVENTS[str(raw.hook_event_name)] ?? 'unknown';
  return evt;
}

// Codex's notify fires only when a turn finishes, with the payload as a CLI
// argument. Fan the one notification into start + prompt + turn-end so the
// board shows an honest coarse card - live activity is not available.
function codexEvent(raw, now) {
  if (str(raw.type) !== 'agent-turn-complete') return [];
  const sessionId = str(raw['turn-id']) ?? str(raw.turn_id);
  const cwd = str(raw.cwd);
  const msgs = Array.isArray(raw['input-messages']) ? raw['input-messages'] : [];
  const prompt = msgs
    .map((m) => (typeof m === 'string' ? m : str(m?.content) ?? str(m?.text)))
    .filter(Boolean)
    .at(-1) ?? null;
  const ts = now();
  return [
    { ts, event: 'SessionStart', sessionId, cwd },
    { ts, event: 'UserPromptSubmit', sessionId, cwd, prompt },
    { ts, event: 'Stop', sessionId, cwd },
  ];
}

// the documented generic-ingest contract: any tool can POST events already in
// the canonical shape to /api/hook-event?source=<its-slug>
function normalizedEvent(raw) {
  return {
    ts: raw.ts,
    event: str(raw.event) ?? 'unknown',
    sessionId: str(raw.sessionId),
    cwd: str(raw.cwd),
    tool: str(raw.tool),
    prompt: str(raw.prompt),
    input: pickInput(raw.input),
    isError: raw.isError === true,
  };
}

const ADAPTERS = {
  [DEFAULT_SOURCE]: claudeEvent,
  'gemini-cli': geminiEvent,
  codex: codexEvent,
  cron: normalizedEvent,
};

// raw wire payload -> canonical events (usually one; Codex fans out, and an
// off-type Codex notify yields none). Unknown sources use the generic shape.
export function sanitizeEvents(raw, { source = DEFAULT_SOURCE, now = Date.now } = {}) {
  const adapter = ADAPTERS[source] ?? normalizedEvent;
  const events = adapter(raw, now);
  return (Array.isArray(events) ? events : [events]).map((evt) => finalize(evt, source, now));
}

// foreign session ids must fit the SLUG_RE-gated /api/flows/:sessionId URL
// and the on-disk file names; normalize once at ingest instead of widening
// the URL gate for every consumer
function normalizeSessionId(id, source, ts) {
  if (!id) return `${source}-${ts}`;
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
  return /^[A-Za-z0-9]/.test(safe) ? safe : `s${safe}`;
}

function finalize(evt, source, now) {
  const ts = typeof evt.ts === 'number' ? evt.ts : now();
  const out = {
    ts,
    source,
    event: evt.event ?? 'unknown',
    sessionId: normalizeSessionId(evt.sessionId, source, ts),
  };
  if (evt.cwd) out.cwd = evt.cwd.replaceAll('\\', '/');
  if (evt.tool) out.tool = evt.tool;
  if (evt.prompt) out.prompt = trunc(evt.prompt, 200);
  if (evt.input) out.input = evt.input;
  if (evt.isError) out.isError = true;
  return out;
}

function isErrorResponse(resp) {
  if (!resp) return false;
  if (resp.is_error === true || resp.isError === true) return true;
  if (typeof resp === 'string') return /^error\b/i.test(resp);
  return false;
}

// evt -> sessions Map upkeep. Exported for tests; the tracker calls it.
export function applyEvent(sessions, evt) {
  let s = sessions.get(evt.sessionId);
  if (!s) {
    s = {
      sessionId: evt.sessionId,
      // pre-0.3 log lines carry no source; they were all Claude Code
      source: evt.source ?? DEFAULT_SOURCE,
      project: evt.cwd ? evt.cwd.split('/').filter(Boolean).pop() : null,
      cwd: evt.cwd ?? null,
      startedAt: evt.ts,
      lastSeen: evt.ts,
      status: 'active',
      activity: null,
      toolCount: 0,
      promptCount: 0,
      sawStart: false,
      errorCount: 0,
      subagents: [],
    };
    sessions.set(evt.sessionId, s);
  }
  s.lastSeen = evt.ts;
  if (evt.cwd && !s.cwd) {
    s.cwd = evt.cwd;
    s.project = evt.cwd.split('/').filter(Boolean).pop();
  }

  switch (evt.event) {
    case 'SessionStart':
      s.status = 'active';
      s.sawStart = true;
      s.activity = 'session started';
      break;
    case 'UserPromptSubmit':
      s.status = 'active';
      s.promptCount += 1;
      s.activity = evt.prompt ? `Prompt: ${evt.prompt}` : 'prompt submitted';
      break;
    case 'PreToolUse':
      s.status = 'active';
      s.toolCount += 1;
      if (isSubagentTool(evt.tool) && evt.input) {
        s.subagents.push({
          type: evt.input.subagent_type ?? 'agent',
          description: evt.input.description ?? null,
          status: 'working',
          startedAt: evt.ts,
          endedAt: null,
        });
        s.activity = `Spawned ${evt.input.subagent_type ?? 'agent'}: ${evt.input.description ?? ''}`.trim();
      } else {
        s.activity = `Running: ${evt.tool ?? 'tool'}${activityDetail(evt.input)}`;
      }
      break;
    case 'PostToolUse':
      if (evt.isError) s.errorCount += 1;
      // deliberately not a completion signal: a backgrounded Agent call returns
      // its handle within milliseconds while the subagent runs on. SubagentStop
      // is the only event that means "this subagent finished".
      break;
    case 'SubagentStop':
      finishOldestWorking(s, evt.ts);
      break;
    case 'Stop':
      s.activity = 'idle - turn ended';
      break;
    case 'SessionEnd':
      s.status = 'ended';
      s.activity = 'session ended';
      break;
    default:
      break;
  }
  return s;
}

// A session that ended without a prompt or a tool call never did work; the
// two shapes it comes in are both Claude desktop app plumbing. Start+End
// within one launch is the app opening and discarding throwaway sessions on
// startup (one per recent project plus one rooted at the home dir) — a user
// opening a window and closing it without typing looks the same. A bare End
// with no Start is the app's periodic housekeeping finalizing old sessions
// in bulk (bursts of a dozen within ~300ms, ~every 2h at :28 while open).
// Cron runs are never caught here: the runner posts a synthetic prompt.
export function classifySession(s) {
  if (s.status !== 'ended' || s.toolCount > 0 || s.promptCount > 0) return 'work';
  // the startup/housekeeping shapes are Claude desktop-app behaviour; another
  // tool's promptless ended session is still its own work
  if (s.source && s.source !== DEFAULT_SOURCE) return 'work';
  return s.sawStart ? 'startup' : 'housekeeping';
}

function finishOldestWorking(s, ts) {
  const working = s.subagents.find((a) => a.status === 'working');
  if (working) {
    working.status = 'done';
    working.endedAt = ts;
  }
}

function activityDetail(input) {
  if (!input) return '';
  const d = input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.url;
  return d ? ` — ${trunc(d, 80)}` : '';
}

export function createAgentTracker({ dataDir = null, staleMs = DEFAULT_STALE_MS, now = Date.now } = {}) {
  const sessions = new Map();

  const logFile = (ts) => {
    const day = new Date(ts).toISOString().slice(0, 10);
    return path.join(dataDir, 'agent-events', `${day}.ndjson`);
  };

  return {
    record(raw, source) {
      const events = sanitizeEvents(raw, { source, now });
      for (const evt of events) {
        if (dataDir) appendLine(logFile(evt.ts), evt);
        applyEvent(sessions, evt);
      }
      return events;
    },
    // a server restart mid-session must not blank the board
    replayToday() {
      if (!dataDir) return 0;
      const events = readLines(logFile(now()));
      for (const evt of events) applyEvent(sessions, evt);
      return events.length;
    },
    snapshot() {
      const ts = now();
      return {
        generatedAt: new Date(ts).toISOString(),
        sessions: [...sessions.values()]
          .map((s) => ({ ...s, subagents: s.subagents.map((a) => ({ ...a })), kind: classifySession(s), stale: s.status === 'active' && ts - s.lastSeen > staleMs }))
          .sort((a, b) => b.lastSeen - a.lastSeen),
      };
    },
  };
}

// --- helpers -------------------------------------------------------------

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function trunc(v, n) {
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}
