// Side panel: fetches a note, renders markdown with clickable wikilinks.
import { renderMarkdown, escapeHtml } from './md.js';

export function createNotePanel({ el, onNavigate, onClose, hasNote, getEdges }) {
  let currentId = null;

  el.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-slug]');
    if (a) {
      ev.preventDefault();
      onNavigate(a.dataset.slug);
      return;
    }
    if (ev.target.closest('.close-btn')) onClose();
  });

  async function show(id) {
    currentId = id;
    const res = await fetch(`/api/note/${encodeURIComponent(id)}`);
    if (currentId !== id) return; // user clicked elsewhere while fetching
    if (!res.ok) {
      renderGhost(id);
      return;
    }
    renderNote(await res.json());
  }

  function renderNote(note) {
    const fm = note.frontmatter ?? {};
    const tags = Array.isArray(fm.tags) ? fm.tags : [];
    el.innerHTML = `
      <div class="note-head">
        <button class="close-btn" title="Close">✕</button>
        <h1>${escapeHtml(note.id)}</h1>
        <div>
          <span class="badge ${escapeHtml(note.type)}">${escapeHtml(note.type)}</span>
          ${tags.map((t) => `<span class="tag-chip">${escapeHtml(String(t))}</span>`).join('')}
        </div>
        ${fm.updated ? `<div class="note-meta">updated ${escapeHtml(String(fm.updated))}${fm.status ? ` · ${escapeHtml(String(fm.status))}` : ''}</div>` : ''}
        ${fm.dir ? `<div class="note-meta">${escapeHtml(String(fm.dir))}</div>` : ''}
        ${fm.description ? `<div class="note-desc">${escapeHtml(String(fm.description))}</div>` : ''}
      </div>
      <div class="note-body">${renderMarkdown(note.markdown)}</div>
    `;
    // dangling wikilinks (no such note yet) get the dashed treatment
    for (const a of el.querySelectorAll('a[data-slug]')) {
      if (!hasNote(a.dataset.slug)) a.classList.add('dangling');
    }
  }

  // an unresolved node: show who references it instead of a 404
  function renderGhost(id) {
    const referrers = [];
    for (const e of getEdges()) {
      if (e.source === id) referrers.push(e.target);
      else if (e.target === id) referrers.push(e.source);
    }
    el.innerHTML = `
      <div class="note-head">
        <button class="close-btn" title="Close">✕</button>
        <h1>${escapeHtml(id)}</h1>
        <div><span class="badge unresolved">unresolved</span></div>
      </div>
      <div class="ghost-note">
        <p>No note named <strong>${escapeHtml(id)}</strong> yet — the vault treats an
        unresolved wikilink as a note worth writing.</p>
        ${referrers.length ? `<p>Referenced by:</p><ul>${referrers.map((r) => `<li><a class="wikilink" data-slug="${escapeHtml(r)}">${escapeHtml(r)}</a></li>`).join('')}</ul>` : ''}
      </div>
    `;
  }

  // an application node is a tag lens, not a file - list what carries the tag
  function showApplication(node, allNodes) {
    currentId = node.id;
    const tag = node.tags[0];
    const members = allNodes.filter((n) => n.type !== 'application' && n.tags.includes(tag));
    el.innerHTML = `
      <div class="note-head">
        <button class="close-btn" title="Close">✕</button>
        <h1>${escapeHtml(node.id)}</h1>
        <div><span class="badge application">application</span><span class="tag-chip">#${escapeHtml(tag)}</span></div>
        <div class="note-desc">Everything in the vault touching ${escapeHtml(tag)}.</div>
      </div>
      <div class="ghost-note">
        <p>${members.length} tagged note${members.length === 1 ? '' : 's'}:</p>
        <ul>${members.map((m) => `<li><a class="wikilink" data-slug="${escapeHtml(m.id)}">${escapeHtml(m.id)}</a> <span class="note-meta">${escapeHtml(m.type)}</span></li>`).join('')}</ul>
      </div>
    `;
  }

  return {
    show,
    showApplication,
    get currentId() { return currentId; },
    clear() { currentId = null; },
  };
}
