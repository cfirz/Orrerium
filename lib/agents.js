// Live agent-session state derived from Claude Code hook events.
// Pure derivation (sanitizeEvent/applyEvent) wrapped by a tracker that owns
// NDJSON persistence under data/agent-events/. No http, no timers - staleness
// is computed on read.
import path from 'node:path';
import { appendLine, readLines } from './store.js';

const DEFAULT_STALE_MS = 90_000;

// The subagent-spawning tool is `Agent`; older Claude Code builds called it
// `Task` and log days from back then still hold those events, so match both.
export function isSubagentTool(tool) {
  return tool === 'Agent' || tool === 'Task';
}

// whitelist + truncate: hook payloads carry whole tool inputs/responses,
// which can be huge; the log keeps only what the board and flows need
export function sanitizeEvent(raw, now = Date.now) {
  const evt = {
    ts: typeof raw.ts === 'number' ? raw.ts : now(),
    event: str(raw.hook_event_name) ?? 'unknown',
    sessionId: str(raw.session_id) ?? 'unknown',
  };
  const cwd = str(raw.cwd);
  if (cwd) evt.cwd = cwd.replaceAll('\\', '/');
  const tool = str(raw.tool_name);
  if (tool) evt.tool = tool;
  const prompt = str(raw.prompt);
  if (prompt) evt.prompt = trunc(prompt, 200);
  if (raw.tool_input && typeof raw.tool_input === 'object') {
    const input = {};
    for (const key of ['subagent_type', 'description', 'command', 'file_path', 'pattern', 'url']) {
      const v = str(raw.tool_input[key]);
      if (v) input[key] = trunc(v, 200);
    }
    if (Object.keys(input).length) evt.input = input;
  }
  if (isErrorResponse(raw.tool_response)) evt.isError = true;
  return evt;
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
    record(raw) {
      const evt = sanitizeEvent(raw, now);
      if (dataDir) appendLine(logFile(evt.ts), evt);
      applyEvent(sessions, evt);
      return evt;
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
