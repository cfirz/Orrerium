import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlow, groupSessions, summarize } from '../lib/flows.js';

const SID = 'flow-session-1';

// the implement-feature shape: prompt, a tool call, two parallel subagents,
// then a third after they close, one error, session end. The third spawn uses
// the legacy `Task` tool name that older log days still hold.
const EVENTS = [
  { ts: 1000, event: 'SessionStart', sessionId: SID, cwd: 'C:/code/DemoApp' },
  { ts: 2000, event: 'UserPromptSubmit', sessionId: SID, prompt: 'implement the coin feature' },
  { ts: 3000, event: 'PreToolUse', sessionId: SID, tool: 'Read', input: { file_path: 'spec.md' } },
  { ts: 4000, event: 'PreToolUse', sessionId: SID, tool: 'Agent', input: { subagent_type: 'creative-agent', description: 'art' } },
  { ts: 4100, event: 'PreToolUse', sessionId: SID, tool: 'Agent', input: { subagent_type: 'unity-agent', description: 'code' } },
  { ts: 4150, event: 'PostToolUse', sessionId: SID, tool: 'Agent' }, // backgrounded handle returning, not a completion
  { ts: 5000, event: 'PostToolUse', sessionId: SID, tool: 'Bash', isError: true },
  { ts: 8000, event: 'SubagentStop', sessionId: SID },
  { ts: 9000, event: 'SubagentStop', sessionId: SID },
  { ts: 9500, event: 'PreToolUse', sessionId: SID, tool: 'Task', input: { subagent_type: 'qa-agent', description: 'verify' } },
  { ts: 11_000, event: 'SubagentStop', sessionId: SID },
  { ts: 12_000, event: 'SessionEnd', sessionId: SID },
];

test('buildFlow: spans, parallel lanes, ticks, prompts', () => {
  const flow = buildFlow(EVENTS);
  assert.equal(flow.start, 1000);
  assert.equal(flow.end, 12_000);

  assert.equal(flow.spans.length, 3);
  const [art, code, qa] = flow.spans;
  assert.equal(art.type, 'creative-agent');
  assert.equal(art.end, 8000); // SubagentStop closes the oldest - not the 4150 PostToolUse
  assert.equal(code.end, 9000); // the next SubagentStop closes the next
  assert.equal(qa.end, 11_000);
  // parallel spans stack; qa starts after both closed, reusing lane 1
  assert.equal(art.lane, 1);
  assert.equal(code.lane, 2);
  assert.equal(qa.lane, 1);
  assert.equal(flow.lanes, 3); // orchestrator + 2

  assert.deepEqual(flow.ticks.map((t) => [t.tool, t.isError ?? false]), [['Read', false], ['Bash', true]]);
  assert.equal(flow.prompts.length, 1);
  assert.equal(flow.spans.some((s) => s.live), false);
});

test('buildFlow: unclosed span stays live', () => {
  const flow = buildFlow(EVENTS.slice(0, 5)); // cut before any close
  assert.equal(flow.spans.length, 2);
  assert.ok(flow.spans.every((s) => s.live && s.end === null));
});

test('groupSessions + summarize', () => {
  const other = [
    { ts: 500, event: 'SessionStart', sessionId: 'other', cwd: 'C:/X/Y' },
    { ts: 550, event: 'PreToolUse', sessionId: 'other', tool: 'Read', input: { file_path: 'a.md' } },
  ];
  const sessions = summarize([...EVENTS, ...other]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, SID); // newest first
  assert.equal(sessions[0].project, 'DemoApp');
  assert.equal(sessions[0].agentCount, 3); // 2 Agent + 1 legacy Task, all stops matched
  assert.equal(sessions[0].toolCount, 4); // Read + 3 spawns
  assert.equal(sessions[0].ended, true);
  assert.equal(sessions[1].project, 'Y');
  assert.equal(groupSessions([...EVENTS, ...other]).get(SID).length, EVENTS.length);
});

test('summarize keeps only sessions with tool calls or subagent evidence', () => {
  const startup = [
    { ts: 100, event: 'SessionStart', sessionId: 'startup', cwd: 'C:/Users/Home' },
    { ts: 600, event: 'SessionEnd', sessionId: 'startup', cwd: 'C:/Users/Home' },
  ];
  const housekeeping = [{ ts: 200, event: 'SessionEnd', sessionId: 'old-one', cwd: 'C:/X/Y' }];
  const cronMarker = [
    { ts: 300, event: 'SessionStart', sessionId: 'cron-x-300', cwd: 'C:/X/Y' },
    { ts: 300, event: 'UserPromptSubmit', sessionId: 'cron-x-300', prompt: '[cron X] go' },
    { ts: 900, event: 'SessionEnd', sessionId: 'cron-x-300', cwd: 'C:/X/Y' },
  ];
  const liveEmpty = [{ ts: 400, event: 'SessionStart', sessionId: 'fresh', cwd: 'C:/X/Y' }];
  // a subagent-run skill leaves only the stop - still a real run, keep it
  const skillRun = [
    { ts: 700, event: 'SessionStart', sessionId: 'skill-run', cwd: 'C:/X/Y' },
    { ts: 800, event: 'SubagentStop', sessionId: 'skill-run' },
  ];

  const rows = summarize([...startup, ...housekeeping, ...cronMarker, ...liveEmpty, ...skillRun]);
  assert.deepEqual(rows.map((s) => s.sessionId), ['skill-run']);
  assert.equal(rows[0].agentCount, 1);
});

test('summarize: skill-run subagents count via unmatched stops', () => {
  const sid = 'skill-heavy';
  const rows = summarize([
    { ts: 1000, event: 'SessionStart', sessionId: sid, cwd: 'C:/X/Proj' },
    { ts: 2000, event: 'PreToolUse', sessionId: sid, tool: 'Read', input: {} },
    { ts: 3000, event: 'SubagentStop', sessionId: sid },
    { ts: 4000, event: 'SubagentStop', sessionId: sid },
    { ts: 5000, event: 'SessionEnd', sessionId: sid },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentCount, 2);
  assert.equal(rows[0].toolCount, 1);
});

test('buildFlow: long idle gaps split into segments with breaks', () => {
  const GAP = 80_000_000;
  const shifted = EVENTS.map((e) => (e.ts >= 9500 ? { ...e, ts: e.ts + GAP } : e));
  const flow = buildFlow(shifted);
  assert.deepEqual(flow.segments, [
    { start: 1000, end: 9000, vStart: 0, vEnd: 8000 },
    { start: 9500 + GAP, end: 12_000 + GAP, vStart: 8000, vEnd: 10_500 },
  ]);
  assert.deepEqual(flow.breaks, [{ at: 9000, skippedMs: 9500 + GAP - 9000 }]);
  assert.equal(flow.activeMs, 10_500);
  // spans still open/close correctly across the gap
  assert.equal(flow.spans.length, 3);
  assert.equal(flow.spans[2].end, 11_000 + GAP);
  // gaps under the threshold never split
  const plain = buildFlow(EVENTS);
  assert.equal(plain.segments.length, 1);
  assert.deepEqual(plain.breaks, []);
  assert.equal(plain.activeMs, 11_000);
});

test('buildFlow: single-event session degenerates cleanly', () => {
  const flow = buildFlow([{ ts: 5000, event: 'SessionStart', sessionId: 's' }]);
  assert.deepEqual(flow.segments, [{ start: 5000, end: 5000, vStart: 0, vEnd: 0 }]);
  assert.deepEqual(flow.breaks, []);
  assert.equal(flow.activeMs, 0);
  assert.equal(flow.spans.length, 0);
});

test('buildFlow: unmatched SubagentStop becomes a start-unknown marker', () => {
  const sid = 's';
  const flow = buildFlow([
    { ts: 1000, event: 'SessionStart', sessionId: sid },
    { ts: 2000, event: 'SubagentStop', sessionId: sid }, // skill-run: no spawn logged
    { ts: 3000, event: 'PreToolUse', sessionId: sid, tool: 'Agent', input: { subagent_type: 'qa-agent' } },
    { ts: 4000, event: 'SubagentStop', sessionId: sid },
    { ts: 5000, event: 'SessionEnd', sessionId: sid },
  ]);
  assert.equal(flow.spans.length, 2);
  const [marker, real] = flow.spans;
  assert.equal(marker.startUnknown, true);
  assert.equal(marker.start, 2000);
  assert.equal(marker.end, 2000); // zero-length: only the finish is known
  assert.equal(real.type, 'qa-agent');
  assert.equal(real.end, 4000); // the real pair still matches up
  assert.ok(!real.startUnknown);
  // spans stay start-sorted and never overlap within a lane
  const byLane = new Map();
  for (const s of flow.spans) {
    assert.ok(s.start >= (byLane.get(s.lane) ?? -Infinity));
    byLane.set(s.lane, s.end);
  }
});
