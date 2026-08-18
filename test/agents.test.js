import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyEvent, classifySession, createAgentTracker, sanitizeEvent } from '../lib/agents.js';

const SID = 'abc12345-0000-0000-0000-000000000000';

function hookEvt(event, extra = {}, ts = 1000) {
  return { ts, hook_event_name: event, session_id: SID, cwd: 'C:\\code\\DemoApp', ...extra };
}

test('sanitizeEvent whitelists, truncates, and normalizes', () => {
  const evt = sanitizeEvent({
    hook_event_name: 'PreToolUse',
    session_id: SID,
    cwd: 'C:\\code\\DemoApp',
    tool_name: 'Bash',
    tool_input: { command: 'x'.repeat(500), secret: 'never-kept', description: 'run tests' },
    tool_response: null,
  }, () => 42);
  assert.equal(evt.ts, 42);
  assert.equal(evt.event, 'PreToolUse');
  assert.equal(evt.cwd, 'C:/code/DemoApp');
  assert.equal(evt.tool, 'Bash');
  assert.equal(evt.input.command.length, 200);
  assert.equal(evt.input.description, 'run tests');
  assert.equal('secret' in evt.input, false);
  assert.equal(evt.isError, undefined);

  const err = sanitizeEvent({ hook_event_name: 'PostToolUse', session_id: SID, tool_name: 'Bash', tool_response: { is_error: true } });
  assert.equal(err.isError, true);
});

test('applyEvent: full session lifecycle with parallel subagents', () => {
  const sessions = new Map();
  const feed = (event, extra, ts) => applyEvent(sessions, sanitizeEvent(hookEvt(event, extra, ts)));

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
    applyEvent(sessions, sanitizeEvent({ ...hookEvt(event, extra, ts), session_id: sid }));

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
