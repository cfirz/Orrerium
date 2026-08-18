import test from 'node:test';
import assert from 'node:assert/strict';
import { STATS_DAYS, buildStats } from '../lib/stats.js';

// fixed clock so day bucketing is deterministic: "today" is 2026-08-18 UTC
const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const now = () => NOW;
const YESTERDAY = Date.UTC(2026, 7, 17, 9, 0, 0);

const evt = (ts, event, sessionId, over = {}) => ({ ts, event, sessionId, ...over });

function fixtureEvents() {
  const s = 'work-session';
  return [
    // an interactive session yesterday: 3 tool calls (2 Read, 1 Agent spawn),
    // one errored response, spread over a minute so activeMs is non-zero
    evt(YESTERDAY, 'SessionStart', s, { cwd: 'C:/code/app' }),
    evt(YESTERDAY + 1000, 'UserPromptSubmit', s, { prompt: 'do the thing' }),
    evt(YESTERDAY + 5000, 'PreToolUse', s, { tool: 'Read' }),
    evt(YESTERDAY + 20_000, 'PreToolUse', s, { tool: 'Read' }),
    evt(YESTERDAY + 30_000, 'PreToolUse', s, { tool: 'Agent' }),
    evt(YESTERDAY + 40_000, 'PostToolUse', s, { tool: 'Agent', isError: true }),
    evt(YESTERDAY + 60_000, 'Stop', s),
    // a cron run today: synthetic prompt, no tools - must count, as cron
    evt(NOW - 3_600_000, 'SessionStart', 'cron-daily-99'),
    evt(NOW - 3_599_000, 'UserPromptSubmit', 'cron-daily-99', { prompt: '[cron daily] tidy' }),
    evt(NOW - 3_500_000, 'SessionEnd', 'cron-daily-99'),
    // desktop-app plumbing: start+end, no prompt, no tools - must not count
    evt(NOW - 1000, 'SessionStart', 'ghost'),
    evt(NOW - 900, 'SessionEnd', 'ghost'),
  ];
}

test('day bucketing, cron/interactive split, tools, errors, spawns, activeMs', () => {
  const stats = buildStats({ events: fixtureEvents(), now });
  assert.equal(stats.days.length, STATS_DAYS);
  assert.equal(stats.days.at(-1).date, '2026-08-18'); // scaffold ends today

  const byDate = new Map(stats.days.map((d) => [d.date, d]));
  const y = byDate.get('2026-08-17');
  assert.equal(y.interactiveSessions, 1);
  assert.equal(y.cronSessions, 0);
  assert.equal(y.toolCalls, 3);
  assert.equal(y.errors, 1);
  assert.equal(y.subagentSpawns, 1);
  assert.ok(y.activeMs > 0);

  const today = byDate.get('2026-08-18');
  assert.equal(today.cronSessions, 1); // synthetic prompt counts it - as cron
  assert.equal(today.interactiveSessions, 0); // the ghost session never counts

  assert.deepEqual(stats.topTools, [{ tool: 'Read', count: 2 }, { tool: 'Agent', count: 1 }]);
  assert.equal(stats.totals.toolCalls, 3);
  assert.equal(stats.totals.interactiveSessions, 1);
  assert.equal(stats.totals.cronSessions, 1);
});

test('cron rollup: counts, average duration, latest run by startedAt', () => {
  const stats = buildStats({
    cronJobs: [{ id: 'daily', name: 'Daily tidy', enabled: true }],
    cronRunsByJob: {
      daily: [
        { startedAt: 2000, ms: 1000, status: 'failed' }, // newest first, like runsFor
        { startedAt: 1000, ms: 5000, status: 'ok' },
      ],
    },
    now,
  });
  assert.deepEqual(stats.crons, [{
    id: 'daily', name: 'Daily tidy', enabled: true,
    runs: 2, ok: 1, failed: 1, avgMs: 3000,
    lastStatus: 'failed', lastAt: 2000,
  }]);
});

test('ask usage groups by provider+model', () => {
  const stats = buildStats({
    conversations: [
      { id: 'a', provider: 'api', model: 'opus', turnCount: 4 },
      { id: 'b', provider: 'api', model: 'opus', turnCount: 2 },
      { id: 'c', provider: 'cli', model: 'sonnet', turnCount: 2 },
    ],
    now,
  });
  assert.equal(stats.ask.conversations, 3);
  assert.equal(stats.ask.turns, 8);
  assert.deepEqual(stats.ask.byModel, [
    { provider: 'api', model: 'opus', conversations: 2, turns: 6 },
    { provider: 'cli', model: 'sonnet', conversations: 1, turns: 2 },
  ]);
});

test('all-empty input returns the zeroed scaffold - the fresh-install contract', () => {
  const stats = buildStats({ days: 5, now });
  assert.equal(stats.days.length, 5);
  assert.ok(stats.days.every((d) => d.toolCalls === 0 && d.interactiveSessions === 0));
  assert.deepEqual(stats.totals, {
    interactiveSessions: 0, cronSessions: 0, toolCalls: 0,
    errors: 0, subagentSpawns: 0, activeMs: 0,
  });
  assert.deepEqual(stats.topTools, []);
  assert.deepEqual(stats.crons, []);
  assert.deepEqual(stats.ask, { conversations: 0, turns: 0, byModel: [] });
});
