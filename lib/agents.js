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

// How long a spawn is believed without a completion. SubagentStop is unreliable
// (see the case below) so a subagent can sit `working` in the record indefinitely;
// past this we stop claiming it is in flight rather than lighting its node until
// the log rolls over. It doubles as the stale window for a session with subagents
// out, which covers the one case where a delegating session really does fall
// silent: a blocking Agent call whose subagent sits in one long tool call.
// (Ordinarily a subagent's tool calls DO surface under the parent session id -
// verified: two parallel Explore agents logged interleaved, duplicate reads of the
// same file in the same second - so a delegating session is normally the opposite
// of quiet.)
const DEFAULT_SUBAGENT_STALE_MS = 900_000;

export const DEFAULT_SOURCE = 'claude-code';

// The subagent-spawning tool is `Agent`; older Claude Code builds called it
// `Task` and log days from back then still hold those events, so match both.
export function isSubagentTool(tool) {
  return tool === 'Agent' || tool === 'Task';
}

// Subagents this session still has in flight, which is what the graph paints, what
// the activity line reports and what the client's liveness test reads - so they all
// count them through here. A SubagentStop that never arrives, or arrives
// unattributable, would otherwise pin a subagent as `working` forever, so each
// spawn carries its own lease.
export function inFlightSubagents(s, ts, leaseMs = DEFAULT_SUBAGENT_STALE_MS) {
  return (s.subagents ?? [])
    .filter((a) => a.status === 'working' && ts - a.startedAt <= leaseMs).length;
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
  // The Agent tool's backgrounding flag, and a boolean rather than a string: it
  // decides whether that call's PostToolUse means "the subagent finished" or only
  // "the handle came back". Absent means backgrounded - that is the tool's default.
  if (typeof toolInput.run_in_background === 'boolean') {
    input.run_in_background = toolInput.run_in_background;
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
      subagentStops: 0,
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
          // a blocking call is the only one whose own PostToolUse is a completion
          background: evt.input.run_in_background !== false,
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
      // For a *blocking* Agent call this is an exact completion: the call does not
      // return until the subagent is done. For a backgrounded one it is worthless -
      // the handle comes back within milliseconds while the subagent runs on (the
      // observed shape is Pre and Post inside the same second). Only the blocking
      // kind closes here, and only one can be in flight at a time, so "the oldest
      // working foreground subagent" is unambiguous.
      if (isSubagentTool(evt.tool)) finishOldestWorking(s, evt.ts, { foregroundOnly: true });
      break;
    case 'SubagentStop':
      // SubagentStop is NOT a dependable completion signal. Measured over a day of
      // this machine's logs: 11 stops, 9 of them landing 3-23s after a `Stop` in
      // sessions that spawned nothing at all (no Agent call, no common tool that
      // would explain one) - it fires at turn end whether a subagent ran or not.
      // Closing "the oldest working" on one of those retires an agent that is still
      // running, and the payload carries no subagent identity to match on. So it is
      // counted, not matched: once the cumulative stops outnumber the spawns, a stop
      // is known-unattributable and closes nothing.
      //
      // The cost is the mirror case - a turn-end stop inflates the counter and can
      // make a later genuine stop look unattributable, leaving that subagent
      // `working`. Deliberate direction to err in for a live read-out, and the lease
      // in inFlightSubagents bounds it. Blocking Agent calls do not rely on any of
      // this: their PostToolUse closes them exactly. See README, "Live agent activity".
      s.subagentStops += 1;
      if (s.subagentStops <= s.subagents.length) finishOldestWorking(s, evt.ts);
      break;
    case 'Stop': {
      // the turn ended, but the work may not have: backgrounded subagents run on
      // and their tool calls never surface under this session id
      const waiting = inFlightSubagents(s, evt.ts);
      s.activity = waiting
        ? `Waiting on ${waiting} subagent${waiting === 1 ? '' : 's'}`
        : 'idle - turn ended';
      break;
    }
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

function finishOldestWorking(s, ts, { foregroundOnly = false } = {}) {
  const working = s.subagents.find((a) => a.status === 'working'
    && (!foregroundOnly || a.background === false));
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

export function createAgentTracker({
  dataDir = null,
  staleMs = DEFAULT_STALE_MS,
  subagentStaleMs = DEFAULT_SUBAGENT_STALE_MS,
  now = Date.now,
} = {}) {
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
          .map((s) => {
            const waiting = inFlightSubagents(s, ts, subagentStaleMs);
            return {
              ...s,
              subagents: s.subagents.map((a) => ({ ...a })),
              kind: classifySession(s),
              waiting, // subagents still in flight - why a silent session can be busy
              stale: s.status === 'active'
                && ts - s.lastSeen > (waiting ? subagentStaleMs : staleMs),
            };
          })
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
