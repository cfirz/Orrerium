// Conversation history for ask-your-brain: a legend-styled floating menu at
// the bottom-right of the graph that lists saved conversations and restores
// one into the ask card. Refetches on every open - no SSE for a single-user
// dashboard.
import { escapeHtml } from './md.js';

export function initAskHistory({ onRestore }) {
  const btn = document.getElementById('ask-history-btn');
  const panel = document.getElementById('ask-history');
  const listEl = document.getElementById('ask-history-list');

  btn.addEventListener('click', () => {
    if (panel.classList.contains('hidden')) open();
    else hide();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') hide();
  });

  listEl.addEventListener('click', async (ev) => {
    const del = ev.target.closest('[data-del]');
    if (del) {
      const res = await fetch(`/api/ask/history/${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' });
      if (res.ok) render((await res.json()).conversations);
      return;
    }
    const row = ev.target.closest('[data-id]');
    if (!row) return;
    const res = await fetch(`/api/ask/history/${encodeURIComponent(row.dataset.id)}`);
    if (!res.ok) return;
    const { conversation } = await res.json();
    onRestore(conversation);
    hide();
  });

  async function open() {
    panel.classList.remove('hidden');
    let conversations = [];
    try {
      const res = await fetch('/api/ask/history');
      if (res.ok) ({ conversations } = await res.json());
    } catch { /* server unreachable - show the empty state */ }
    render(conversations);
  }

  function hide() { panel.classList.add('hidden'); }

  function render(conversations) {
    if (!conversations.length) {
      listEl.innerHTML = '<div class="ask-history-empty">No conversations yet</div>';
      return;
    }
    listEl.innerHTML = conversations.map((c) => `
      <div class="ask-history-row" data-id="${escapeHtml(c.id)}">
        <span class="ask-history-title">${escapeHtml(c.title)}</span>
        <span class="ask-history-time">${when(c.updatedAt)}</span>
        <button class="ask-history-del" data-del="${escapeHtml(c.id)}" title="Delete conversation">✕</button>
      </div>`).join('');
  }

  function when(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
}
