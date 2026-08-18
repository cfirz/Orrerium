// Stats: usage rollups over everything Orrerium logs, from GET /api/stats.
// Tiles always render (zeros are honest); the chart is skipped only when
// nothing at all has been logged, so a fresh install gets one clear line
// instead of a degenerate all-zero plot.
import { escapeHtml } from './md.js';
import { fmtDur } from './fmt.js';

const CHART_W = 820;
const PLOT_H = 110;
const PAD_X = 8;

export function createStatsPanel() {
  const head = document.getElementById('stats-head');
  const tiles = document.getElementById('stats-tiles');
  const daysEl = document.getElementById('stats-days');
  const toolsEl = document.getElementById('stats-tools');
  const cronsEl = document.getElementById('stats-crons');
  const askEl = document.getElementById('stats-ask');
  let refreshTimer = null;

  async function refresh() {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    render(await res.json());
  }

  // every hook event fires an agents SSE broadcast, and each refresh re-reads
  // a fortnight of logs server-side - debounce, and only while visible
  function poke() {
    if (document.body.dataset.panel !== 'stats') return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 1000);
  }

  function render(stats) {
    head.innerHTML = `<h1>STATS</h1>
      <div class="board-sub">last ${stats.days.length} days of agent, cron and ask activity</div>`;
    const t = stats.totals;
    tiles.innerHTML = [
      tile(t.interactiveSessions, 'sessions'),
      tile(t.cronSessions, 'cron runs'),
      tile(t.toolCalls, 'tool calls'),
      tile(t.errors, 'tool errors'),
      tile(t.subagentSpawns, 'subagents'),
      tile(t.activeMs ? fmtDur(t.activeMs) : '0s', 'active time'),
    ].join('');
    const empty = t.toolCalls === 0 && stats.crons.length === 0 && stats.ask.conversations === 0;
    daysEl.innerHTML = empty
      ? '<p class="agents-empty">Stats build up from the Agents-board hooks, cron runs and ask conversations — nothing logged yet.</p>'
      : chart(stats.days);
    toolsEl.innerHTML = `<div class="stats-h">TOP TOOLS</div>${toolRows(stats.topTools)}`;
    cronsEl.innerHTML = `<div class="stats-h">CRONS</div>${cronRows(stats.crons)}`;
    askEl.innerHTML = `<div class="stats-h">ASK</div>${askRows(stats.ask)}`;
  }

  return { refresh, onAgents: poke, onCrons: poke };
}

const tile = (value, label) =>
  `<div class="stat-tile"><div class="stat-num">${escapeHtml(String(value))}</div><div class="stat-label">${label}</div></div>`;

// rounded top, flat bottom: the data end gets the radius, the baseline stays anchored
function barPath(x, w, h) {
  const r = Math.min(2, h);
  const top = PLOT_H - h;
  return `M${x},${PLOT_H} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${PLOT_H} Z`;
}

function chart(days) {
  const max = Math.max(1, ...days.map((d) => d.toolCalls));
  const slot = (CHART_W - PAD_X * 2) / days.length;
  const barW = Math.min(26, Math.max(6, slot - 8));
  const h = (v) => (v / max) * (PLOT_H - 16); // headroom for the max label
  const groups = days.map((d, i) => {
    const cx = PAD_X + slot * i + slot / 2;
    const today = i === days.length - 1;
    return `<g class="stats-day">
      ${d.toolCalls > 0 ? `<path class="stat-bar" d="${barPath(cx - barW / 2, barW, h(d.toolCalls))}"/>` : ''}
      ${d.errors > 0 ? `<path class="stat-bar-err" d="${barPath(cx - 4, 8, h(d.errors))}"/>` : ''}
      <text class="stats-tick${today ? ' today' : ''}" x="${cx}" y="${PLOT_H + 14}" text-anchor="middle">${d.date.slice(5)}</text>
      <title>${d.date}: ${d.toolCalls} tool calls, ${d.errors} errors</title>
    </g>`;
  });
  return `<div class="stats-legend">
      <span><span class="stats-dot" style="background: var(--stat-bar)"></span>tool calls</span>
      <span><span class="stats-dot" style="background: var(--c-lesson)"></span>errors</span>
    </div>
    <svg viewBox="0 0 ${CHART_W} ${PLOT_H + 22}" role="img" aria-label="Tool calls and errors per day">
      <text class="stats-max" x="${PAD_X}" y="10">${max}</text>
      <line class="stats-axis" x1="0" y1="${PLOT_H}" x2="${CHART_W}" y2="${PLOT_H}"/>
      ${groups.join('')}
    </svg>`;
}

function toolRows(topTools) {
  if (topTools.length === 0) return '<p class="agents-empty">No tool calls logged yet.</p>';
  const max = topTools[0].count;
  return topTools.map(({ tool, count }) => `<div class="tool-row">
      <span class="tool-name" title="${escapeHtml(tool)}">${escapeHtml(tool)}</span>
      <div class="tool-track"><div class="tool-bar" style="width: ${Math.max(2, (count / max) * 100)}%"></div></div>
      <span class="tool-count">${count}</span>
    </div>`).join('');
}

function cronRows(crons) {
  if (crons.length === 0) return '<p class="agents-empty">No cron jobs yet.</p>';
  return crons.map((c) => `<div class="stats-cron-row${c.enabled ? '' : ' off'}">
      <span class="cron-name">${escapeHtml(c.name)}</span>
      <span class="stats-ok">${c.ok} ok</span>
      <span class="stats-failed">${c.failed} failed</span>
      <span class="stats-dim">avg ${c.avgMs ? fmtDur(c.avgMs) : '—'}</span>
    </div>`).join('');
}

function askRows(ask) {
  if (ask.conversations === 0) return '<p class="agents-empty">No conversations yet.</p>';
  const models = ask.byModel.map((m) => `<div class="stats-ask-row">
      ${escapeHtml(m.model ?? '?')} <span class="stats-dim">via ${escapeHtml(m.provider ?? '?')}</span>
      — ${m.conversations} conversation${m.conversations === 1 ? '' : 's'}, ${m.turns} turns
    </div>`).join('');
  return `<div class="stats-ask-row">${ask.conversations} saved conversation${ask.conversations === 1 ? '' : 's'}, ${ask.turns} turns (all saved, capped at 100)</div>${models}`;
}
