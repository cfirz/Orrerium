// Crons: job list + week calendar over the in-process scheduler. Jobs run
// `claude -p` headless; each run's output tail is viewable inline.
import { escapeHtml } from './md.js';

const DAY_MS = 86_400_000;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function createCronsPanel() {
  const head = document.getElementById('crons-head');
  const form = document.getElementById('cron-form');
  const err = document.getElementById('cron-form-err');
  const listEl = document.getElementById('crons-list');
  const calEl = document.getElementById('crons-calendar');
  const detail = document.getElementById('cron-detail');

  let jobs = [];
  let runsByJob = new Map();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const def = {
      name: document.getElementById('cron-name').value,
      schedule: document.getElementById('cron-schedule').value,
      cwd: document.getElementById('cron-cwd').value.trim() || null,
      prompt: document.getElementById('cron-prompt').value,
      catchUp: document.getElementById('cron-catchup').checked,
    };
    const res = await fetch('/api/crons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(def),
    });
    if (!res.ok) {
      err.textContent = (await res.json()).error ?? 'failed';
      return;
    }
    form.reset();
    refresh();
  });

  listEl.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]');
    const row = ev.target.closest('[data-job]');
    if (!row) return;
    const id = row.dataset.job;
    const job = jobs.find((j) => j.id === id);
    if (!btn) return showRuns(id);
    if (btn.dataset.action === 'run') {
      btn.disabled = true;
      await fetch(`/api/crons/${encodeURIComponent(id)}/run`, { method: 'POST' });
      refresh();
    } else if (btn.dataset.action === 'toggle') {
      await fetch('/api/crons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...job, enabled: !job.enabled }),
      });
      refresh();
    } else if (btn.dataset.action === 'delete') {
      await fetch(`/api/crons/${encodeURIComponent(id)}`, { method: 'DELETE' });
      detail.innerHTML = '';
      refresh();
    }
  });

  function relNext(ts) {
    if (ts == null) return 'off';
    const s = Math.round((ts - Date.now()) / 1000);
    if (s <= 0) return 'due';
    if (s < 60) return `in ${s}s`;
    if (s < 3600) return `in ${Math.round(s / 60)}m`;
    if (s < 86_400) return `in ${Math.round(s / 3600)}h`;
    return `in ${Math.round(s / 86_400)}d`;
  }

  function render() {
    head.innerHTML = `
      <h1>CRONS</h1>
      <div class="board-sub">${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${jobs.filter((j) => j.enabled).length} enabled</div>
      <div class="board-hint">Scheduled <code>claude -p</code> runs. The scheduler lives inside BrainOS — jobs
      fire while the server runs; <b>catch-up</b> jobs run once at startup when an occurrence was missed.</div>`;

    listEl.innerHTML = jobs.length ? jobs.map((j) => `
      <div class="cron-row${j.enabled ? '' : ' off'}" data-job="${escapeHtml(j.id)}">
        <span class="agent-dot ${j.running ? 'active' : j.enabled ? 'stale' : 'ended'}"></span>
        <span class="cron-name">${escapeHtml(j.name)}</span>
        <span class="cron-schedule">${escapeHtml(j.schedule)}</span>
        <span class="cron-next">${j.running ? 'running…' : relNext(j.enabled ? j.nextRun : null)}</span>
        ${j.lastRun ? `<span class="cron-last ${j.lastRun.status}">${j.lastRun.status}</span>` : '<span class="cron-last">never ran</span>'}
        <span class="cron-actions">
          <button class="seg-btn" data-action="run" title="Run now">▶</button>
          <button class="seg-btn" data-action="toggle" title="${j.enabled ? 'Disable' : 'Enable'}">${j.enabled ? '⏻' : '○'}</button>
          <button class="seg-btn" data-action="delete" title="Delete">🗑</button>
        </span>
      </div>`).join('')
      : '<p class="agents-empty">No jobs yet — add one above. Try <code>daily@07:30</code> with a vault-triage reminder prompt.</p>';

    renderCalendar();
  }

  function renderCalendar() {
    // current week, monday first, local time
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY_MS);
    const days = [...Array(7)].map((_, i) => new Date(monday.getTime() + i * DAY_MS));

    calEl.innerHTML = days.map((day, i) => {
      const next = day.getTime() + DAY_MS;
      const isToday = day.getTime() === today.getTime();
      const past = [];
      for (const [jobId, runs] of runsByJob) {
        for (const r of runs) {
          if (r.startedAt >= day.getTime() && r.startedAt < next) {
            past.push({ jobId, ...r });
          }
        }
      }
      past.sort((a, b) => a.startedAt - b.startedAt);
      const future = jobs
        .filter((j) => j.enabled && j.nextRun != null && j.nextRun >= day.getTime() && j.nextRun < next)
        .map((j) => ({ id: j.id, ts: j.nextRun }));
      const t = (ts) => new Date(ts).toTimeString().slice(0, 5);
      return `
        <div class="cal-day${isToday ? ' today' : ''}">
          <div class="cal-day-name">${DAY_NAMES[i]} <span>${day.getDate()}</span></div>
          ${past.map((r) => `<div class="cal-run ${r.status}" data-cal-job="${escapeHtml(r.jobId)}" title="${escapeHtml(r.jobId)} · ${r.status}">● ${t(r.startedAt)} ${escapeHtml(r.jobId)}</div>`).join('')}
          ${future.map((f) => `<div class="cal-run next" title="next run">○ ${t(f.ts)} ${escapeHtml(f.id)}</div>`).join('')}
        </div>`;
    }).join('');

    calEl.querySelectorAll('[data-cal-job]').forEach((el) => {
      el.addEventListener('click', () => showRuns(el.dataset.calJob));
    });
  }

  async function showRuns(id) {
    const res = await fetch(`/api/crons/${encodeURIComponent(id)}/runs`);
    if (!res.ok) return;
    const { runs } = await res.json();
    detail.innerHTML = `
      <div class="agent-card">
        <div class="agent-title"><span class="cron-name">${escapeHtml(id)}</span><span class="agent-when">${runs.length} run${runs.length === 1 ? '' : 's'}</span></div>
        ${runs.length === 0 ? '<div class="agent-activity">no runs yet</div>' : ''}
        ${runs.slice(0, 5).map((r) => `
          <div class="cron-run-block">
            <div class="agent-meta">
              <span class="cron-last ${r.status}">${r.status}</span>
              <span>${new Date(r.startedAt).toLocaleString()}</span>
              <span>${Math.round(r.ms / 1000)}s</span>
              <span>${escapeHtml(r.trigger)}</span>
              <span>exit ${r.exitCode}</span>
            </div>
            <pre class="cron-output">${escapeHtml(r.outputTail || '(no output)')}</pre>
          </div>`).join('')}
      </div>`;
  }

  async function refresh() {
    const res = await fetch('/api/crons');
    if (!res.ok) return;
    jobs = (await res.json()).jobs;
    runsByJob = new Map();
    await Promise.all(jobs.map(async (j) => {
      const r = await fetch(`/api/crons/${encodeURIComponent(j.id)}/runs`);
      if (r.ok) runsByJob.set(j.id, (await r.json()).runs);
    }));
    render();
  }

  return {
    refresh,
    onCrons(data) {
      jobs = data.jobs;
      render();
    },
  };
}
