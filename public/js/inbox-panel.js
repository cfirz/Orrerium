// Inbox triage view: renders inbox.md's capture buffer as cards and flags
// when it has passed the vault's ~10-line triage threshold.
import { renderMarkdown } from './md.js';

const TRIAGE_LINES = 10;

export function createInboxPanel({ onNavigate }) {
  const head = document.getElementById('inbox-head');
  const list = document.getElementById('inbox-entries');

  list.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-slug]');
    if (a) {
      ev.preventDefault();
      onNavigate(a.dataset.slug);
    }
  });
  head.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-slug]');
    if (a) {
      ev.preventDefault();
      onNavigate(a.dataset.slug);
    }
  });

  async function refresh() {
    const res = await fetch('/api/note/inbox');
    if (!res.ok) {
      head.innerHTML = '<h1>INBOX</h1><div class="board-sub">no inbox.md in this vault</div>';
      list.innerHTML = '';
      return;
    }
    const note = await res.json();
    // strip the header comment; entries are the remaining paragraph blocks
    const body = note.markdown.replace(/<!--[\s\S]*?-->/, '');
    const entries = body
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s && !/^#\s/.test(s));
    const lineCount = entries.join('\n').split('\n').filter((l) => l.trim()).length;
    const ready = lineCount >= TRIAGE_LINES;

    head.innerHTML = `
      <h1>INBOX</h1>
      <div class="board-sub">${entries.length} capture${entries.length === 1 ? '' : 's'} · ${lineCount} lines${ready ? ' · <span class="ready">ready for triage</span>' : ''}</div>
      <div class="board-hint">Append-only capture buffer. The <a class="wikilink" data-slug="capture">capture</a> routine writes here;
      <a class="wikilink" data-slug="triage">triage</a> promotes entries into real notes once it passes ~${TRIAGE_LINES} lines.</div>`;

    list.innerHTML = entries
      .map((e) => `<div class="inbox-entry note-body">${renderMarkdown(e)}</div>`)
      .join('');
  }

  return { refresh };
}
