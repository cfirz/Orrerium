// Usage rollups over everything Orrerium logs: agent hook events, cron run
// records, ask conversations. Pure - the server hands in what it read from
// data/ and gets the /api/stats payload back. Recomputed per request: the
// sources are small (a couple MB of NDJSON), independently mutated, and a
// single local user is behind the panel's 1s debounce; memoizing on day-file
// mtimes is the escape hatch if this ever shows in a profile.
import { groupSessions, buildFlow } from './flows.js';
import { isSubagentTool } from './agents.js';

export const STATS_DAYS = 14; // matches FLOW_DAYS - the window the server reads

const DAY_MS = 86_400_000;
const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);

export function buildStats({
  events = [], cronJobs = [], cronRunsByJob = {},
  conversations = [], days = STATS_DAYS, now = Date.now,
} = {}) {
  // the day scaffold comes first, zero-filled: charts always get a stable
  // domain, and a fresh install renders sane zeros instead of null-guards
  const t = now();
  const byDay = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const date = dayOf(t - i * DAY_MS);
    byDay.set(date, {
      date, interactiveSessions: 0, cronSessions: 0,
      toolCalls: 0, errors: 0, subagentSpawns: 0, activeMs: 0,
    });
  }

  const toolTally = new Map();
  for (const [sessionId, sessionEvents] of groupSessions(events)) {
    let prompts = 0;
    let tools = 0;
    for (const evt of sessionEvents) {
      const evtDay = byDay.get(dayOf(evt.ts)); // tool ticks land on their own day
      if (evt.event === 'UserPromptSubmit') prompts += 1;
      if (evt.event === 'PreToolUse') {
        tools += 1;
        if (evt.tool) toolTally.set(evt.tool, (toolTally.get(evt.tool) ?? 0) + 1);
        if (evtDay) {
          evtDay.toolCalls += 1;
          if (isSubagentTool(evt.tool)) evtDay.subagentSpawns += 1;
        }
      }
      if (evt.event === 'PostToolUse' && evt.isError && evtDay) evtDay.errors += 1;
    }
    // sessions count when they prompted or worked - NOT flows' tools-only
    // rule, because a cron run carries a synthetic prompt and often zero
    // tools; desktop-app startup/housekeeping plumbing has neither
    if (prompts === 0 && tools === 0) continue;
    const day = byDay.get(dayOf(sessionEvents[0].ts));
    if (!day) continue; // older than the window
    // cron runs impersonate sessions (server synthesizes the cron- prefix);
    // split them out so they are never double-counted as interactive work
    if (sessionId.startsWith('cron-')) day.cronSessions += 1;
    else day.interactiveSessions += 1;
    day.activeMs += buildFlow(sessionEvents).activeMs ?? 0;
  }

  const topTools = [...toolTally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tool, count]) => ({ tool, count }));

  const crons = cronJobs.map((job) => {
    const runs = cronRunsByJob[job.id] ?? [];
    const ok = runs.filter((r) => r.status === 'ok').length;
    const last = runs.reduce((a, b) => (a == null || b.startedAt > a.startedAt ? b : a), null);
    return {
      id: job.id,
      name: job.name,
      enabled: job.enabled !== false,
      runs: runs.length,
      ok,
      failed: runs.length - ok,
      avgMs: runs.length ? Math.round(runs.reduce((s, r) => s + (r.ms ?? 0), 0) / runs.length) : 0,
      lastStatus: last?.status ?? null,
      lastAt: last?.startedAt ?? null,
    };
  });

  const byModel = new Map();
  let askTurns = 0;
  for (const c of conversations) {
    const turns = c.turnCount ?? c.turns?.length ?? 0;
    askTurns += turns;
    const key = `${c.provider ?? ''}|${c.model ?? ''}`;
    const rec = byModel.get(key)
      ?? { provider: c.provider ?? null, model: c.model ?? null, conversations: 0, turns: 0 };
    rec.conversations += 1;
    rec.turns += turns;
    byModel.set(key, rec);
  }

  const dayRows = [...byDay.values()];
  const totals = dayRows.reduce((sum, d) => ({
    interactiveSessions: sum.interactiveSessions + d.interactiveSessions,
    cronSessions: sum.cronSessions + d.cronSessions,
    toolCalls: sum.toolCalls + d.toolCalls,
    errors: sum.errors + d.errors,
    subagentSpawns: sum.subagentSpawns + d.subagentSpawns,
    activeMs: sum.activeMs + d.activeMs,
  }), { interactiveSessions: 0, cronSessions: 0, toolCalls: 0, errors: 0, subagentSpawns: 0, activeMs: 0 });

  return {
    generatedAt: new Date(t).toISOString(),
    days: dayRows,
    totals,
    topTools,
    crons,
    ask: {
      conversations: conversations.length,
      turns: askTurns,
      byModel: [...byModel.values()].sort((a, b) => b.conversations - a.conversations),
    },
  };
}
