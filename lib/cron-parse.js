// Pure schedule grammar for crons: `every 30m`, `every 2h`, `daily@07:30`,
// `weekly@mon 09:00`. Local-time Date arithmetic keeps daily/weekly runs
// pinned to wall-clock time across DST shifts. Full 5-field cron syntax is
// deliberately out of scope until something needs it.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function parseSchedule(schedule) {
  if (typeof schedule !== 'string') throw new Error('schedule must be a string');
  const s = schedule.trim().toLowerCase();

  let m = /^every\s+(\d+)\s*(m|h)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (n < 1) throw new Error(`schedule interval must be >= 1: "${schedule}"`);
    return { kind: 'every', intervalMs: n * (m[2] === 'h' ? 3_600_000 : 60_000) };
  }
  m = /^daily@(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const [h, min] = [Number(m[1]), Number(m[2])];
    if (h > 23 || min > 59) throw new Error(`bad time in "${schedule}"`);
    return { kind: 'daily', h, min };
  }
  m = /^weekly@([a-z]{3})\s+(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const dow = DAYS.indexOf(m[1]);
    const [h, min] = [Number(m[2]), Number(m[3])];
    if (dow === -1) throw new Error(`bad day "${m[1]}" in "${schedule}" (use ${DAYS.join('/')})`);
    if (h > 23 || min > 59) throw new Error(`bad time in "${schedule}"`);
    return { kind: 'weekly', dow, h, min };
  }
  throw new Error(`unrecognized schedule "${schedule}" (use "every 30m", "daily@07:30", "weekly@mon 09:00")`);
}

export function computeNextRun(schedule, now = Date.now()) {
  const s = parseSchedule(schedule);
  if (s.kind === 'every') return now + s.intervalMs;
  const d = new Date(now);
  d.setHours(s.h, s.min, 0, 0);
  if (s.kind === 'daily') {
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // weekly: roll forward to the target weekday, then one week if already past
  d.setDate(d.getDate() + ((s.dow - d.getDay() + 7) % 7));
  if (d.getTime() <= now) d.setDate(d.getDate() + 7);
  return d.getTime();
}

// the most recent scheduled occurrence at-or-before `now` - catch-up logic
// compares it against the last actual run. `every` anchors on the last run
// instead, so it has no fixed grid: returns null.
export function computePrevRun(schedule, now = Date.now()) {
  const s = parseSchedule(schedule);
  if (s.kind === 'every') return null;
  const d = new Date(now);
  d.setHours(s.h, s.min, 0, 0);
  if (s.kind === 'daily') {
    if (d.getTime() > now) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  d.setDate(d.getDate() - ((d.getDay() - s.dow + 7) % 7));
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

// a run was missed if a scheduled occurrence passed since the last run
export function missedRun(job, lastRunTs, now = Date.now()) {
  const s = parseSchedule(job.schedule);
  if (s.kind === 'every') {
    return lastRunTs != null && now - lastRunTs > s.intervalMs;
  }
  const prev = computePrevRun(job.schedule, now);
  return prev != null && (lastRunTs == null || lastRunTs < prev);
}
