import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyEvent, classifySession, createAgentTracker, sanitizeEvents } from '../lib/agents.js';

const SID = 'abc12345-0000-0000-0000-000000000000';

function hookEvt(event, extra = {}, ts = 1000) {
  return { ts, hook_event_name: event, session_id: SID, cwd: 'C:\\code\\DemoApp', ...extra };
}

const one = (raw, opts) => {
  const events = sanitizeEvents(raw, opts);
  assert.equal(events.length, 1);
  return events[0];
};

test('sanitizeEvents whitelists, truncates, and normalizes claude payloads', () => {
  const evt = one({
    hook_event_name: 'PreToolUse',
    session_id: SID,
    cwd: 'C:\\code\\DemoApp',
    tool_name: 'Bash',
    tool_input: { command: 'x'.repeat(500), secret: 'never-kept', description: 'run tests' },
    tool_response: null,
  }, { now: () => 42 });
  assert.equal(evt.ts, 42);
  assert.equal(evt.source, 'claude-code'); // the default when no source is given
  assert.equal(evt.event, 'PreToolUse');
  assert.equal(evt.cwd, 'C:/code/DemoApp');
  assert.equal(evt.tool, 'Bash');
  assert.equal(evt.input.command.length, 200);
  assert.equal(evt.input.description, 'run tests');
  assert.equal('secret' in evt.input, false);
  assert.equal(evt.isError, undefined);

  const err = one({ hook_event_name: 'PostToolUse', session_id: SID, tool_name: 'Bash', tool_response: { is_error: true } });
  assert.equal(err.isError, true);
});

test('sanitizeEvents: gemini-cli events map into the canonical vocabulary', () => {
  const evt = one({
    hook_event_name: 'BeforeTool', session_id: SID, cwd: '/repo',
    tool_name: 'run_shell_command', tool_input: { command: 'ls' },
  }, { source: 'gemini-cli' });
  assert.equal(evt.source, 'gemini-cli');
  assert.equal(evt.event, 'PreToolUse');
  assert.equal(evt.tool, 'run_shell_command');
  assert.equal(evt.input.command, 'ls');

  assert.equal(one(
    { hook_event_name: 'BeforeAgent', session_id: SID, prompt: 'do it' },
    { source: 'gemini-cli' },
  ).event, 'UserPromptSubmit');
  assert.equal(one(
    { hook_event_name: 'AfterAgent', session_id: SID },
    { source: 'gemini-cli' },
  ).event, 'Stop');
  // model/notification chatter is not part of the canonical vocabulary
  assert.equal(one(
    { hook_event_name: 'BeforeModel', session_id: SID },
    { source: 'gemini-cli' },
  ).event, 'unknown');
});

test('sanitizeEvents: one codex notify fans out into start + prompt + turn end', () => {
  const events = sanitizeEvents({
    type: 'agent-turn-complete',
    'turn-id': 'turn-77',
    'input-messages': ['first ask', 'fix the tests'],
    'last-assistant-message': 'Done.',
  }, { source: 'codex', now: () => 500 });
  assert.deepEqual(events.map((e) => e.event), ['SessionStart', 'UserPromptSubmit', 'Stop']);
  assert.ok(events.every((e) => e.source === 'codex' && e.sessionId === 'turn-77' && e.ts === 500));
  assert.equal(events[1].prompt, 'fix the tests'); // the latest input message

  // any other notify type produces nothing rather than a junk card
  assert.deepEqual(sanitizeEvents({ type: 'something-else' }, { source: 'codex' }), []);
});

test('sanitizeEvents: unknown sources read the normalized generic shape', () => {
  const evt = one({
    ts: 7, event: 'PreToolUse', sessionId: 'run-1', cwd: '/ci',
    tool: 'compile', input: { description: 'build it' },
  }, { source: 'my-tool' });
  assert.equal(evt.source, 'my-tool');
  assert.equal(evt.tool, 'compile');
  assert.equal(evt.input.description, 'build it');
});

test('sanitizeEvents: foreign session ids are normalized to slug-safe form', () => {
  const evt = one({ event: 'SessionStart', sessionId: 'proj:runs/2026 08#18' }, { source: 'my-tool' });
  assert.equal(evt.sessionId, 'proj-runs-2026-08-18');
  assert.match(one({ event: 'SessionStart' }, { source: 'my-tool', now: () => 99 }).sessionId, /^my-tool-99$/);
  // a leading non-alphanumeric would fail the URL gate; it gets a prefix
  assert.match(one({ event: 'SessionStart', sessionId: '-x' }, { source: 'my-tool' }).sessionId, /^s-x$/);
  assert.equal(one({ event: 'SessionStart', sessionId: 'y'.repeat(300) }, { source: 'my-tool' }).sessionId.length, 128);
});

test('applyEvent: full session lifecycle with parallel subagents', () => {
  const sessions = new Map();
  const feed = (event, extra, ts) => applyEvent(sessions, one(hookEvt(event, extra, ts)));

  feed('SessionStart', {}, 1000);
  feed('UserPromptSubmit', { prompt: 'implement the feature' }, 2000);
  feed('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } }, 3000);
  feed('PostToolUse', { tool_name: 'Bash', tool_response: { is_error: true } }, 4000);
  feed('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'creative-agent', description: 'draw the art' } }, 5000);
  feed('PreToolUse', { tool_name: 'Task', tool_input: { subagent_type: 'unity-agent', description: 'write the code' } }, 5100); // legacy tool name
  feed('PostToolUse', { tool_name: 'Agent' }, 5150); // backgrounded handle returning - closes nothing
  feed('SubagentStop', {}, 8000);
  feed('SubagentStop', {}, 9000);
  feed('Stop', {}, 9500);

  const s = sessions.get(SID);
  assert.equal(s.project, 'DemoApp');
  assert.equal(s.status, 'active');
  assert.equal(s.toolCount, 3); // Bash + 2 subagent spawns
  assert.equal(s.errorCount, 1);
  assert.equal(s.subagents.length, 2);
  assert.deepEqual(s.subagents.map((a) => a.status), ['done', 'done']); // one SubagentStop each
  assert.equal(s.subagents[0].endedAt, 8000);
  assert.equal(s.subagents[1].endedAt, 9000);
  assert.equal(s.activity, 'idle - turn ended');
  assert.equal(s.lastSeen, 9500);

  feed('SessionEnd', {}, 10_000);
  assert.equal(s.status, 'ended');
});

test('tracker: persists NDJSON, replays after restart, marks stale', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'orrerium-agents-'));
  let clock = 1000;
  const now = () => clock;

  const t1 = createAgentTracker({ dataDir, staleMs: 500, now });
  t1.record(hookEvt('SessionStart', {}, 1000));
  clock = 1200;
  t1.record(hookEvt('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'x.md' } }, 1200));

  // "restart": a fresh tracker over the same data dir sees the same day's log
  const t2 = createAgentTracker({ dataDir, staleMs: 500, now });
  assert.equal(t2.replayToday(), 2);
  let snap = t2.snapshot();
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].toolCount, 1);
  assert.equal(snap.sessions[0].stale, false);

  clock = 5000; // long silence -> stale
  snap = t2.snapshot();
  assert.equal(snap.sessions[0].stale, true);
});

test('classifySession separates work from app plumbing', () => {
  const sessions = new Map();
  const feed = (sid, event, extra = {}, ts = 1000) =>
    applyEvent(sessions, one({ ...hookEvt(event, extra, ts), session_id: sid }));

  // desktop app startup artifact: Start+End, no prompt, no tools
  feed('startup-sid', 'SessionStart', {}, 1000);
  feed('startup-sid', 'SessionEnd', {}, 1500);
  assert.equal(classifySession(sessions.get('startup-sid')), 'startup');

  // housekeeping burst: bare End for a session started days ago
  feed('old-sid', 'SessionEnd', {}, 2000);
  assert.equal(classifySession(sessions.get('old-sid')), 'housekeeping');

  // a live session with nothing yet is still work, not noise
  feed('fresh-sid', 'SessionStart', {}, 3000);
  assert.equal(classifySession(sessions.get('fresh-sid')), 'work');

  // cron runs carry a synthetic prompt, so ending tool-less stays work
  feed('cron-sid', 'SessionStart', {}, 4000);
  feed('cron-sid', 'UserPromptSubmit', { prompt: '[cron X] do it' }, 4000);
  feed('cron-sid', 'SessionEnd', {}, 5000);
  assert.equal(classifySession(sessions.get('cron-sid')), 'work');

  // snapshot carries the kind
  const dataDir = mkdtempSync(path.join(tmpdir(), 'orrerium-agents-'));
  const t = createAgentTracker({ dataDir, now: () => 1000 });
  t.record(hookEvt('SessionStart', {}, 1000));
  t.record(hookEvt('SessionEnd', {}, 1200));
  assert.equal(t.snapshot().sessions[0].kind, 'startup');
});

test('classifySession: the plumbing heuristics only apply to claude-code sessions', () => {
  const sessions = new Map();
  // a promptless ended gemini session is that tool's own work, never "startup"
  for (const evt of sanitizeEvents({ hook_event_name: 'SessionStart', session_id: 'g1' }, { source: 'gemini-cli' })) applyEvent(sessions, evt);
  for (const evt of sanitizeEvents({ hook_event_name: 'SessionEnd', session_id: 'g1' }, { source: 'gemini-cli' })) applyEvent(sessions, evt);
  assert.equal(classifySession(sessions.get('g1')), 'work');
  // the same shape from claude-code is still the app startup artifact
  for (const evt of sanitizeEvents(hookEvt('SessionStart', { session_id: 'c1' }))) applyEvent(sessions, evt);
  for (const evt of sanitizeEvents(hookEvt('SessionEnd', { session_id: 'c1' }))) applyEvent(sessions, evt);
  assert.equal(classifySession(sessions.get('c1')), 'startup');
});

test('tracker: sessions carry their source into the snapshot', () => {
  const t = createAgentTracker({ now: () => 1000 });
  t.record(hookEvt('SessionStart', {}, 1000));
  t.record({ event: 'SessionStart', sessionId: 'x-1', ts: 1000 }, 'my-tool');
  const by = Object.fromEntries(t.snapshot().sessions.map((s) => [s.sessionId, s.source]));
  assert.equal(by[SID], 'claude-code');
  assert.equal(by['x-1'], 'my-tool');
});

test('tracker: replays pre-source log lines as claude-code', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'orrerium-agents-'));
  const dayFile = path.join(dataDir, 'agent-events', '1970-01-01.ndjson');
  mkdirSync(path.dirname(dayFile), { recursive: true });
  // verbatim lines from a pre-0.3 log: normalized shape, no source field
  writeFileSync(dayFile, [
    '{"ts":1000,"event":"SessionStart","sessionId":"old-1","cwd":"C:/code/DemoApp"}',
    '{"ts":1200,"event":"PreToolUse","sessionId":"old-1","tool":"Bash"}',
  ].join('\n') + '\n');
  const t = createAgentTracker({ dataDir, now: () => 1500 });
  assert.equal(t.replayToday(), 2);
  const s = t.snapshot().sessions[0];
  assert.equal(s.source, 'claude-code');
  assert.equal(s.toolCount, 1);
});
