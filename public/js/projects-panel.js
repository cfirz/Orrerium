// Projects board: one card per project page, built from the frontmatter the
// vault already carries (status, dir, tags, updated) plus graph degree.
import { escapeHtml } from './md.js';

export function createProjectsPanel({ onOpen }) {
  const head = document.getElementById('projects-head');
  const grid = document.getElementById('projects-grid');

  grid.addEventListener('click', (ev) => {
    const card = ev.target.closest('[data-id]');
    if (card) onOpen(card.dataset.id);
  });

  function render(graphData) {
    if (!graphData) return;
    const projects = graphData.nodes
      .filter((n) => n.type === 'project')
      .sort((a, b) => ((b.status === 'active') - (a.status === 'active')) || b.degree - a.degree);
    const active = projects.filter((p) => p.status === 'active').length;

    head.innerHTML = `
      <h1>PROJECTS</h1>
      <div class="board-sub">${projects.length} project page${projects.length === 1 ? '' : 's'} · ${active} active</div>
      <div class="board-hint">Cards come straight from the vault's frontmatter — click one to see it in the graph.</div>`;

    grid.innerHTML = projects.map((p) => `
      <div class="proj-card" data-id="${escapeHtml(p.id)}">
        <div class="proj-title">
          <span>${escapeHtml(p.id)}</span>
          ${p.status ? `<span class="status-chip">${escapeHtml(p.status)}</span>` : ''}
        </div>
        ${p.description ? `<div class="proj-desc">${escapeHtml(p.description)}</div>` : ''}
        ${p.tags?.length ? `<div class="proj-tags">${p.tags.map((t) => `<span class="tag-chip">${escapeHtml(String(t))}</span>`).join('')}</div>` : ''}
        <div class="proj-meta">
          <span>${p.degree} link${p.degree === 1 ? '' : 's'}</span>
          ${p.updated ? `<span>updated ${escapeHtml(p.updated)}</span>` : ''}
        </div>
        ${p.dir ? `<div class="proj-dir">${escapeHtml(p.dir)}</div>` : ''}
      </div>`).join('');
  }

  return { render };
}
