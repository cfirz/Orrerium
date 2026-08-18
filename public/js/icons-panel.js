// Icons: pixel-face gallery with click-to-assign. Pick a face, click an
// agent; the assignment is Orrerium-owned state (data/icon-assignments.json)
// and every consumer (board, graph) updates over the bus.
import { ICONS, renderIcon } from './icons.js';
import { escapeHtml } from './md.js';

export function createIconsPanel({ getGraphData }) {
  const head = document.getElementById('icons-head');
  const gallery = document.getElementById('icons-gallery');
  const agentsEl = document.getElementById('icons-agents');

  let assignments = {};
  let selected = null; // icon name, '' = clear tool, null = nothing selected

  gallery.addEventListener('click', (ev) => {
    const cell = ev.target.closest('[data-icon]');
    if (!cell) return;
    selected = selected === cell.dataset.icon ? null : cell.dataset.icon;
    render();
  });

  agentsEl.addEventListener('click', async (ev) => {
    const row = ev.target.closest('[data-agent]');
    if (!row || selected === null) return;
    await fetch('/api/icons/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: row.dataset.agent, icon: selected === '' ? null : selected }),
    });
    // the server broadcasts `icons`; main.js routes it back via setAssignments
  });

  function render() {
    const names = Object.keys(ICONS);
    head.innerHTML = `
      <h1>ICONS</h1>
      <div class="board-sub">${names.length} faces · ${Object.keys(assignments).length} assigned</div>
      <div class="board-hint">${selected === null
        ? 'Pick a face, then click an agent to assign it.'
        : selected === ''
          ? 'Clear tool armed — click an agent to remove its face.'
          : `<b>${escapeHtml(selected)}</b> armed — click an agent below.`}</div>`;

    gallery.innerHTML = [
      ...names.map((n) => `
        <button class="icon-cell${selected === n ? ' selected' : ''}" data-icon="${n}" title="${n}">
          ${renderIcon(n, 40)}<span>${n}</span>
        </button>`),
      `<button class="icon-cell clear${selected === '' ? ' selected' : ''}" data-icon="" title="clear">
        <span class="icon-clear-glyph">✕</span><span>clear</span>
      </button>`,
    ].join('');

    const agents = (getGraphData()?.nodes ?? [])
      .filter((n) => n.type === 'agent')
      .sort((a, b) => a.id.localeCompare(b.id));
    agentsEl.innerHTML = agents.length
      ? agents.map((a) => `
          <div class="icon-agent-row" data-agent="${escapeHtml(a.id)}">
            <span class="icon-slot">${assignments[a.id] ? renderIcon(assignments[a.id], 22) : ''}</span>
            <span class="subagent-type">${escapeHtml(a.label ?? a.id)}</span>
            <span class="agent-cwd">${escapeHtml(a.id)}</span>
          </div>`).join('')
      : '<p class="agents-empty">No agents on the graph yet - the cross-repo scan found nothing.</p>';
  }

  return {
    refresh: async () => {
      const res = await fetch('/api/icons');
      if (res.ok) assignments = (await res.json()).assignments;
      render();
    },
    setAssignments(a) {
      assignments = a;
      render();
    },
    rerender: render, // the agent list depends on graph data that loads async
  };
}
