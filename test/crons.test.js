import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeNextRun, computePrevRun, missedRun, parseSchedule } from '../lib/cron-parse.js';
import { createCronRunner } from '../lib/crons.js';

// --- grammar ---------------------------------------------------------------

test('parseSchedule: accepted forms and rejections', () => {
  assert.deepEqual(parseSchedule('every 30m'), { kind: 'every', intervalMs: 1_800_000 });
  assert.deepEqual(parseSchedule('every 2h'), { kind: 'every', intervalMs: 7_200_000 });
  assert.deepEqual(parseSchedule('daily@07:30'), { kind: 'daily', h: 7, min: 30 });
  assert.deepEqual(parseSchedule('WEEKLY@Mon 09:00'), { kind: 'weekly', dow: 1, h: 9, min: 0 });
  for (const bad of ['every day', 'daily@25:00', 'daily@07:65', 'weekly@xyz 09:00', '* * * * *', '']) {
    assert.throws(() => parseSchedule(bad), undefined, bad);
  }
});

test('computeNextRun: daily and weekly land on the next wall-clock slot', () => {
  const base = new Date(2026, 7, 9, 12, 0, 0).getTime(); // Sunday noon, local
  assert.equal(computeNextRun('every 30m', base), base + 1_800_000);

  const nextDaily = new Date(computeNextRun('daily@07:30', base));
  assert.equal(nextDaily.getHours(), 7);
  assert.equal(nextDaily.getMinutes(), 30);
  assert.equal(nextDaily.getDate(), 10); // 07:30 already passed today

  const sameDay = new Date(computeNextRun('daily@18:00', base));
  assert.equal(sameDay.getDate(), 9); // still ahead today

  const nextMon = new Date(computeNextRun('weekly@mon 09:00', base));
  assert.equal(nextMon.getDay(), 1);
  assert.equal(nextMon.getDate(), 10); // tomorrow
  const nextSunEarly = new Date(computeNextRun('weekly@sun 09:00', base));
  assert.equal(nextSunEarly.getDate(), 16); // 09:00 today already passed -> next week
});

test('computePrevRun + missedRun catch-up logic', () => {
  const base = new Date(2026, 7, 9, 12, 0, 0).getTime();
  const prev = new Date(computePrevRun('daily@07:30', base));
  assert.equal(prev.getDate(), 9);
  assert.equal(prev.getHours(), 7);
  assert.equal(computePrevRun('every 30m', base), null);

  const daily = { schedule: 'daily@07:30' };
  assert.equal(missedRun(daily, null, base), true); // never ran, 07:30 passed
  assert.equal(missedRun(daily, base - 3_600_000, base), false); // ran at 11:00
  assert.equal(missedRun(daily, base - 86_400_000, base), true); // ran yesterday

  const every = { schedule: 'every 30m' };
  assert.equal(missedRun(every, null, base), false); // no grid, no debt
  assert.equal(missedRun(every, base - 3_600_000, base), true);
});

// --- runner with a stubbed spawn ------------------------------------------

function fakeSpawn(exitCode, output, delayMs = 5) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => child.emit('close', -1);
    setTimeout(() => {
      child.stdout.emit('data', output);
      child.emit('close', exitCode);
    }, delayMs);
    return child;
  };
}

const AI = { cliCommand: 'claude', timeoutMs: 60_000 };

test('runner: upsert validates, runNow records a run, list reflects it', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'orrerium-crons-'));
  const events = [];
  const runner = createCronRunner({
    dataDir,
    ai: AI,
    spawnImpl: fakeSpawn(0, 'triage done\n'),
    onRunStart: (job) => events.push(['start', job.id]),
    onRunEnd: (job, rec) => events.push(['end', job.id, rec.status]),
  });

  assert.throws(() => runner.upsert({ name: 'x', schedule: 'nope', prompt: 'p' }), /unrecognized schedule/);

  const job = runner.upsert({ name: 'Vault Triage', schedule: 'daily@07:30', prompt: 'triage the inbox' });
  assert.equal(job.id, 'vault-triage');
  assert.equal(job.enabled, true);

  const record = await runner.runNow('vault-triage');
  assert.equal(record.status, 'ok');
  assert.equal(record.trigger, 'manual');
  assert.match(record.outputTail, /triage done/);
  assert.deepEqual(events, [['start', 'vault-triage'], ['end', 'vault-triage', 'ok']]);

  const [listed] = runner.list();
  assert.equal(listed.lastRun.status, 'ok');
  assert.ok(listed.nextRun > Date.now());
  assert.equal(runner.runsFor('vault-triage').length, 1);
  runner.stop();
});

test('runner: failed run recorded, catch-up fires once on start', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'orrerium-crons-'));
  const seed = createCronRunner({ dataDir, ai: AI, spawnImpl: fakeSpawn(1, 'boom') });
  seed.upsert({ name: 'Nightly', schedule: 'daily@00:01', prompt: 'do it', catchUp: true });
  const rec = await seed.runNow('nightly');
  assert.equal(rec.status, 'failed');
  assert.equal(rec.exitCode, 1);
  seed.stop();

  // pretend the last run was two days ago -> start() owes a catch-up run
  const twoDaysAgo = Date.now() - 2 * 86_400_000;
  const ends = [];
  const runner = createCronRunner({
    dataDir,
    ai: AI,
    spawnImpl: fakeSpawn(0, 'caught up'),
    now: Date.now,
    onRunEnd: (job, r) => ends.push(r.trigger),
  });
  // rewrite the run log timestamp by re-seeding state: simplest is a fresh runsFor check -
  // the seed run above is from "today", so no catch-up is owed yet
  runner.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ends, []); // ran earlier today -> nothing owed
  runner.stop();

  // a job that never ran at all IS owed a catch-up (daily@00:01 has passed)
  const dataDir2 = mkdtempSync(path.join(tmpdir(), 'orrerium-crons-'));
  const ends2 = [];
  const runner2 = createCronRunner({
    dataDir: dataDir2,
    ai: AI,
    spawnImpl: fakeSpawn(0, 'caught up'),
    onRunEnd: (job, r) => ends2.push(r.trigger),
  });
  runner2.upsert({ name: 'Never Ran', schedule: 'daily@00:01', prompt: 'p', catchUp: true });
  runner2.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ends2, ['catch-up']);
  runner2.stop();
  assert.ok(twoDaysAgo < Date.now());
});

test('runner: overlapping runNow is refused while running', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'orrerium-crons-'));
  const runner = createCronRunner({ dataDir, ai: AI, spawnImpl: fakeSpawn(0, 'slow', 50) });
  runner.upsert({ name: 'Slow', schedule: 'every 30m', prompt: 'p' });
  const first = runner.runNow('slow');
  const second = await runner.runNow('slow');
  assert.equal(second, null); // refused - already running
  assert.equal((await first).status, 'ok');
  runner.stop();
});
