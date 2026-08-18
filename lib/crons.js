// Cron runtime: definitions in data/crons.json, a setTimeout-chain scheduler,
// and runs of `claude -p` (the ask.js spawn shape) with output captured under
// data/cron-runs/. Substrate decision: in-process, not Windows Task Scheduler -
// all state stays in files an agent can read; a per-job catchUp flag fires
// once on startup when a scheduled occurrence was missed while the server
// was down.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveCliInvocation } from './cli-spawn.js';
import { appendLine, readJson, readLines, writeJson } from './store.js';
import { computeNextRun, missedRun, parseSchedule } from './cron-parse.js';

const MAX_TIMEOUT = 2 ** 31 - 1; // setTimeout clamp
const TAIL_CHARS = 2000;

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function createCronRunner({ dataDir, ai, onChange = () => {}, onRunStart = () => {}, onRunEnd = () => {}, spawnImpl = spawn, now = Date.now }) {
  const DEFS_FILE = path.join(dataDir, 'crons.json');
  const RUNS_DIR = path.join(dataDir, 'cron-runs');

  let jobs = readJson(DEFS_FILE, []);
  const state = new Map(); // id -> { timer, running, nextRun }

  const runsFile = (id) => path.join(RUNS_DIR, `${id}.ndjson`);

  function lastRun(id) {
    const runs = readLines(runsFile(id));
    return runs.length ? runs[runs.length - 1] : null;
  }

  function validate(def) {
    if (typeof def?.name !== 'string' || !def.name.trim()) throw new Error('name is required');
    parseSchedule(def.schedule); // throws with a usable message
    if (typeof def.prompt !== 'string' || !def.prompt.trim()) throw new Error('prompt is required');
  }

  function upsert(def) {
    validate(def);
    const id = def.id ?? slugify(def.name);
    if (!id) throw new Error('name must contain something sluggable');
    const job = {
      id,
      name: def.name.trim(),
      schedule: def.schedule.trim(),
      prompt: def.prompt,
      cwd: def.cwd ?? null,
      skill: def.skill ?? null,
      enabled: def.enabled !== false,
      timeoutMs: Number(def.timeoutMs) > 0 ? Number(def.timeoutMs) : 10 * 60_000,
      catchUp: def.catchUp === true,
    };
    const i = jobs.findIndex((j) => j.id === id);
    if (i === -1) jobs.push(job);
    else jobs[i] = job;
    writeJson(DEFS_FILE, jobs);
    schedule(job);
    onChange();
    return job;
  }

  function remove(id) {
    jobs = jobs.filter((j) => j.id !== id);
    writeJson(DEFS_FILE, jobs);
    const st = state.get(id);
    if (st?.timer) clearTimeout(st.timer);
    state.delete(id);
    onChange();
  }

  function schedule(job) {
    const st = state.get(job.id) ?? {};
    if (st.timer) clearTimeout(st.timer);
    if (!job.enabled) {
      state.set(job.id, { ...st, timer: null, nextRun: null });
      return;
    }
    const next = computeNextRun(job.schedule, now());
    const delay = Math.min(Math.max(0, next - now()), MAX_TIMEOUT);
    const timer = setTimeout(() => {
      runJob(job.id).finally(() => {
        const cur = jobs.find((j) => j.id === job.id);
        if (cur) schedule(cur); // chain, def may have changed meanwhile
      });
    }, delay);
    timer.unref?.();
    state.set(job.id, { ...st, timer, nextRun: next });
  }

  async function runJob(id, trigger = 'schedule') {
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error(`no cron "${id}"`);
    const st = state.get(id) ?? {};
    if (st.running) return null; // never overlap a job with itself
    st.running = true;
    state.set(id, st);
    const startedAt = now();
    mkdirSync(path.join(RUNS_DIR, id), { recursive: true });
    const logFile = path.join(RUNS_DIR, id, `${startedAt}.log`);
    onRunStart(job, startedAt);
    onChange();

    const result = await new Promise((resolve) => {
      let out = '';
      let settled = false;
      const settle = (r) => { if (!settled) { settled = true; resolve(r); } };
      let child;
      try {
        const cli = resolveCliInvocation(ai.cliCommand, ['-p', '--output-format', 'text']);
        child = spawnImpl(cli.file, cli.args, {
          ...cli.options,
          windowsHide: true,
          cwd: job.cwd ?? undefined,
        });
      } catch (err) {
        return settle({ exitCode: -1, output: `spawn failed: ${err.message}` });
      }
      const timer = setTimeout(() => {
        child.kill();
        settle({ exitCode: -1, output: `${out}\n[timeout after ${job.timeoutMs / 1000}s]` });
      }, job.timeoutMs);
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { out += d; });
      child.on('error', (err) => {
        clearTimeout(timer);
        settle({ exitCode: -1, output: `${out}\nspawn error: ${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        settle({ exitCode: code ?? -1, output: out });
      });
      child.stdin?.end(job.prompt);
    });

    const endedAt = now();
    try {
      writeFileSync(logFile, result.output);
    } catch { /* the tail in the run record still survives */ }
    const record = {
      startedAt,
      endedAt,
      ms: endedAt - startedAt,
      trigger,
      exitCode: result.exitCode,
      status: result.exitCode === 0 ? 'ok' : 'failed',
      outputTail: result.output.slice(-TAIL_CHARS),
    };
    appendLine(runsFile(id), record);
    st.running = false;
    onRunEnd(job, record);
    onChange();
    return record;
  }

  function list() {
    return jobs.map((j) => {
      const st = state.get(j.id) ?? {};
      const last = lastRun(j.id);
      return { ...j, running: Boolean(st.running), nextRun: st.nextRun ?? null, lastRun: last };
    });
  }

  function start() {
    for (const job of jobs) {
      if (job.enabled && job.catchUp && missedRun(job, lastRun(job.id)?.startedAt ?? null, now())) {
        // fire-and-forget; scheduling continues regardless
        runJob(job.id, 'catch-up').catch(() => {});
      }
      schedule(job);
    }
  }

  function stop() {
    for (const st of state.values()) {
      if (st.timer) clearTimeout(st.timer);
    }
  }

  return {
    list,
    upsert,
    remove,
    runNow: (id) => runJob(id, 'manual'),
    runsFor: (id, limit = 50) => readLines(runsFile(id)).slice(-limit).reverse(),
    start,
    stop,
  };
}
