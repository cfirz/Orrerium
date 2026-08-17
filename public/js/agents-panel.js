// Agents board: one card per Claude Code session, fed live by hook events
// over the bus. Empty until the hooks in ~/.claude/settings.json are enabled.
import { escapeHtml } from './md.js';

// filter id -> [label, predicate over a snapshot session]
const FILTERS = [
  ['all', 'All', (s) => s.kind === 'work'],
  ['live', 'Live', (s) => s.kind === 'work' && s.status === 'active' && !s.stale],
  ['idle', 'Idle', (s) => s.kind === 'work' && s.status === 'active' && s.stale],
  ['ended', 'Ended', (s) => s.kind === 'work' && s.status === 'ended'],
  ['system', 'System', (s) => s.kind !== 'work'],
];

const SYSTEM_LABEL = {
  startup: 'claude-code app startup — empty session, no prompt ever ran',
  housekeeping: 'housekeeping — app closed an old session, nothing ran',
};

export function createAgentsPanel({ getIcon } = {}) {
  const head = document.getElementById('agents-head');
  const cards = document.getElementById('agents-cards');
  let lastSnapshot = null;
  let filter = 'all';

  head.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    filter = btn.dataset.filter;
    if (lastSnapshot) render(lastSnapshot);
  });

  function relAgo(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }

  function dotClass(s) {
    if (s.status === 'ended') return 'ended';
    return s.stale ? 'stale' : 'active';
  }

  function render(snapshot) {
    lastSnapshot = snapshot;
    // kind arrives from /api/agents; an older server just means nothing is filtered
    const sessions = (snapshot?.sessions ?? []).map((s) => ({ kind: 'work', ...s }));
    const active = sessions.filter((s) => s.status === 'active' && !s.stale).length;
    const work = sessions.filter((s) => s.kind === 'work');
    const shown = sessions.filter(FILTERS.find(([id]) => id === filter)[2]);

    head.innerHTML = `
      <h1>AGENTS</h1>
      <div class="board-sub">${work.length} session${work.length === 1 ? '' : 's'} today · ${active} live</div>
      <div class="board-hint">Every Claude Code session on this machine reports here through the
      <code>hooks/emit.js</code> hook — orchestrators, their subagents, and what they are running.
      System is the desktop app's own plumbing: startup artifacts and housekeeping closures.</div>
      <div class="agents-filters">${FILTERS.map(([id, label, pred]) => `
        <button class="seg-btn${id === filter ? ' active' : ''}" data-filter="${id}">${label}
          <span class="chip-count">${sessions.filter(pred).length}</span></button>`).join('')}
      </div>`;

    if (sessions.length === 0) {
      cards.innerHTML = `
        <div class="agents-empty">
          <p>No sessions logged yet.</p>
          <p>Wire the emitter into <code>~/.claude/settings.json</code> (see the BrainOS README,
          "Agents board") and any Claude Code session on this machine will appear here live.</p>
        </div>`;
      return;
    }
    if (shown.length === 0) {
      cards.innerHTML = `<div class="agents-empty"><p>Nothing matches this filter.</p></div>`;
      return;
    }

    cards.innerHTML = shown.map((s) => `
      <div class="agent-card${s.status === 'ended' ? ' ended' : ''}${s.kind !== 'work' ? ' system' : ''}">
        <div class="agent-title">
          <span class="agent-dot ${dotClass(s)}"></span>
          <span class="agent-project">${escapeHtml(s.project ?? 'unknown')}</span>
          <span class="agent-session" title="${escapeHtml(s.sessionId)}">${escapeHtml(s.sessionId.slice(0, 8))}</span>
          <span class="agent-when">${relAgo(s.lastSeen)}</span>
        </div>
        ${s.kind !== 'work'
          ? `<div class="agent-activity">${SYSTEM_LABEL[s.kind] ?? 'system event'}</div>`
          : s.activity ? `<div class="agent-activity">${escapeHtml(s.activity)}</div>` : ''}
        <div class="agent-meta">
          ${s.kind === 'work' ? `<span>${s.toolCount} tool call${s.toolCount === 1 ? '' : 's'}</span>` : ''}
          ${s.errorCount ? `<span class="agent-errors">${s.errorCount} error${s.errorCount === 1 ? '' : 's'}</span>` : ''}
          ${s.cwd ? `<span class="agent-cwd">${escapeHtml(s.cwd)}</span>` : ''}
        </div>
        ${s.subagents.length ? `<div class="subagent-rows">${s.subagents.map((a) => `
          <div class="subagent-row">
            <span class="agent-dot ${a.status === 'working' ? 'active' : 'done'}"></span>
            ${getIcon?.(s.project, a.type, 18) ?? ''}
            <span class="subagent-type">${escapeHtml(a.type)}</span>
            ${a.description ? `<span class="subagent-desc">${escapeHtml(a.description)}</span>` : ''}
          </div>`).join('')}</div>` : ''}
      </div>`).join('');
  }

  async function refresh() {
    if (lastSnapshot) render(lastSnapshot); // repaint (e.g. icon change) without waiting
    const res = await fetch('/api/agents');
    if (res.ok) render(await res.json());
  }

  return { render, refresh };
}
