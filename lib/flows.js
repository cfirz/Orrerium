// Pure flow builder: sanitized hook events (lib/agents.js shapes) -> a
// replayable timeline. No fs, no http of its own - the server feeds it NDJSON
// lines, tests feed it fixtures; the one import is a shared event predicate.
import { isSubagentTool } from './agents.js';

export function groupSessions(events) {
  const by = new Map();
  for (const evt of events) {
    if (!evt?.sessionId) continue;
    if (!by.has(evt.sessionId)) by.set(evt.sessionId, []);
    by.get(evt.sessionId).push(evt);
  }
  for (const list of by.values()) list.sort((a, b) => a.ts - b.ts);
  return by;
}

// one row per session, newest first - the flows panel's session picker.
// Sessions with no tool call and no subagent evidence are desktop-app
// plumbing (startup artifacts, housekeeping closures, synthetic cron
// markers) - nothing to replay, so they get no row. A SubagentStop counts
// as evidence even without a spawn: subagent-run skills emit only the stop.
export function summarize(events) {
  const out = [];
  for (const [sessionId, list] of groupSessions(events)) {
    const toolCount = list.filter((e) => e.event === 'PreToolUse').length;
    let spawns = 0;
    let openSpawns = 0;
    let unmatchedStops = 0;
    for (const e of list) {
      if (e.event === 'PreToolUse' && isSubagentTool(e.tool)) {
        spawns += 1;
        openSpawns += 1;
      } else if (e.event === 'SubagentStop') {
        if (openSpawns > 0) openSpawns -= 1;
        else unmatchedStops += 1;
      }
    }
    if (toolCount === 0 && unmatchedStops === 0) continue;
    const cwd = list.find((e) => e.cwd)?.cwd ?? null;
    out.push({
      sessionId,
      project: cwd ? cwd.split('/').filter(Boolean).pop() : null,
      start: list[0].ts,
      end: list[list.length - 1].ts,
      ended: list.some((e) => e.event === 'SessionEnd'),
      agentCount: spawns + unmatchedStops,
      toolCount,
    });
  }
  return out.sort((a, b) => b.start - a.start);
}

// consecutive events further apart than this split the run into separate
// active segments; the client collapses each break to a fixed-width marker
export const GAP_THRESHOLD_MS = 120_000;

// One session's events -> lanes/spans/ticks. Lane 0 is the orchestrator;
// subagent spans open at `PreToolUse Agent` and close oldest-first on
// `SubagentStop` (hook payloads carry no correlation id, same heuristic as the
// live board). `PostToolUse Agent` is not a close: a backgrounded agent returns
// its handle in milliseconds and keeps running, which would collapse the span
// to a sliver. A stop with nothing open (subagent-run skills spawn without an
// Agent PreToolUse) becomes a zero-length start-unknown marker. Parallel spans
// stack on separate lanes.
export function buildFlow(events) {
  const list = [...events].sort((a, b) => a.ts - b.ts);
  const start = list.length ? list[0].ts : 0;
  const end = list.length ? list[list.length - 1].ts : 0;

  // idle-gap segmentation: vStart/vEnd are cumulative active-time offsets,
  // the domain the client's scrubber and piecewise scale operate in
  const segments = [];
  const breaks = [];
  for (const evt of list) {
    const seg = segments[segments.length - 1];
    if (!seg) {
      segments.push({ start: evt.ts, end: evt.ts });
    } else if (evt.ts - seg.end > GAP_THRESHOLD_MS) {
      breaks.push({ at: seg.end, skippedMs: evt.ts - seg.end });
      segments.push({ start: evt.ts, end: evt.ts });
    } else {
      seg.end = evt.ts;
    }
  }
  let activeMs = 0;
  for (const seg of segments) {
    seg.vStart = activeMs;
    activeMs += seg.end - seg.start;
    seg.vEnd = activeMs;
  }

  const spans = [];
  const ticks = [];
  const prompts = [];
  const open = []; // spans awaiting a close, oldest first

  for (const evt of list) {
    switch (evt.event) {
      case 'UserPromptSubmit':
        prompts.push({ ts: evt.ts, text: evt.prompt ?? '' });
        break;
      case 'PreToolUse':
        if (isSubagentTool(evt.tool)) {
          const span = {
            type: evt.input?.subagent_type ?? 'agent',
            description: evt.input?.description ?? null,
            start: evt.ts,
            end: null,
            lane: 0, // assigned below
          };
          spans.push(span);
          open.push(span);
        } else {
          ticks.push({ ts: evt.ts, tool: evt.tool ?? 'tool' });
        }
        break;
      case 'PostToolUse':
        if (evt.isError) ticks.push({ ts: evt.ts, tool: evt.tool ?? 'tool', isError: true });
        break;
      case 'SubagentStop':
        if (!closeOldest(open, evt.ts)) {
          spans.push({ type: 'subagent', description: null, start: evt.ts, end: evt.ts, lane: 0, startUnknown: true });
        }
        break;
      default:
        break;
    }
  }
  // still-open spans run to the timeline's right edge but stay marked live
  for (const span of open) span.live = true;

  // greedy lane packing: lowest free lane >= 1, so parallel agents stack.
  // The packer requires start order - cheap insurance, markers included.
  spans.sort((a, b) => a.start - b.start);
  const laneEnds = []; // laneEnds[i] = when lane i+1 frees up
  for (const span of spans) {
    const spanEnd = span.end ?? end;
    let lane = laneEnds.findIndex((t) => t <= span.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(spanEnd);
    } else {
      laneEnds[lane] = spanEnd;
    }
    span.lane = lane + 1;
  }

  return { start, end, lanes: laneEnds.length + 1, spans, ticks, prompts, segments, breaks, activeMs };
}

function closeOldest(open, ts) {
  const span = open.shift();
  if (span) span.end = ts;
  return Boolean(span);
}
